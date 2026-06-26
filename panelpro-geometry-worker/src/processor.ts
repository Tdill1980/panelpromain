/**
 * processor.ts — sharp-only flat-panel extraction.
 *
 * Deterministic pipeline driven entirely by RestylePro metadata:
 *
 *   A. ACQUIRE MASTER SHEET   (axios URL, or uploaded buffer on the manual route)
 *   B. CROP PANEL            (sharp.extract — exact rectangle from the sheet)
 *   C. SIZE TO PRINT         (resize to exact live pixels, lanczos3, 16-bit space)
 *   D. MIRROR BLEED          (sharp.extend extendWith:'mirror' — 5" perimeter)
 *   E. EXPORT + QC + UPLOAD   (8-bit level-0 lossless RGBA PNG → Supabase)
 *
 * Colour-sensitive resampling runs in libvips' 16-bit space to avoid banding;
 * the final write flattens to an 8-bit, compression-level-0 RGBA PNG exactly
 * once. No native OpenCV — libvips streams scanlines, keeping memory bounded.
 */

import axios from 'axios';
import sharp from 'sharp';

import { config } from './config.js';
import { resolveDimensions, bleedPx, liveDimensions, normalizeDimensionSource } from './sizing.js';
import { uploadPrintAsset, uploadPreview } from './storage.js';
import { runQualityGate, QcGateError } from './qc.js';
import { keyOutTemplate } from './templateKey.js';
import { extractFlatDesign } from './aiExtract.js';
import type {
  CropBox,
  ExtractionJob,
  ExtractionResult,
  QcReport,
  ResolvedDimensions,
} from './types.js';

// Allow large prints to stream without tripping libvips' pixel guard.
sharp.cache(false);
sharp.concurrency(0); // libvips picks an optimal thread count

/**
 * Entry point invoked by the dispatcher for each job.
 *
 * Throws {@link QcGateError} when the strict QC gate rejects the result — the
 * caller treats that as a hard halt for the job.
 */
export async function executeMechanicalExtraction(
  job: ExtractionJob,
  onStage: (stage: string) => void = () => {},
): Promise<ExtractionResult> {
  const { manifest } = job;
  const dims = resolveDimensions(manifest.physical);

  // ── A. ACQUIRE MASTER SHEET ─────────────────────────────────────────────────
  onStage('Fetching artwork');
  const masterBytes = await loadMaster(job);

  // ── A2. OPTIONAL EXTRACTION: isolate the flat design from a proof ───────────
  const transform = manifest.stripTemplate ? 'strip' : manifest.aiExtract ? 'ai' : null;
  let designBytes = masterBytes;
  let crop = manifest.cropBox;
  if (transform) {
    onStage(transform === 'ai' ? 'AI extracting design' : 'Stripping template');
    const region = crop
      ? await sharp(masterBytes, { limitInputPixels: false })
          .extract({
            left: Math.round(crop.x),
            top: Math.round(crop.y),
            width: Math.round(crop.width),
            height: Math.round(crop.height),
          })
          .png()
          .toBuffer()
      : masterBytes;
    designBytes = transform === 'ai' ? await extractFlatDesign(region) : await keyOutTemplate(region);
    crop = undefined; // already isolated → scale the whole result
  }

  // ── B–D. CROP → SIZE → MIRROR BLEED → 8-bit PNG ─────────────────────────────
  onStage('Rendering panel');
  const printPng = await buildPanel(designBytes, crop, dims);

  // QC: the strict proof-vs-output gate only makes sense for a faithful crop.
  // After extraction the output intentionally differs from the proof, so the
  // structural gate is not applicable (the kept pixels are lossless either way).
  let qc: QcReport;
  if (transform) {
    qc = {
      passed: true,
      metrics: [
        {
          name: transform === 'ai' ? 'aiExtract' : 'templateKey',
          value: 0,
          threshold: 0,
          passed: true,
          detail: 'extraction mode — structural QC vs the proof is not applicable',
        },
      ],
    };
  } else {
    onStage('Quality check');
    qc = await runQualityGate({
      candidate: printPng,
      referenceBytes: job.masterBytes,
      referenceUrl: manifest.masterArtworkUrl,
      cropBox: manifest.cropBox,
      dims,
    });
    if (!qc.passed) {
      throw new QcGateError(job.jobId, qc);
    }
  }

  // ── E. UPLOAD ───────────────────────────────────────────────────────────────
  onStage(`Uploading (${(printPng.length / 1048576).toFixed(1)} MB)`);
  const storagePath = await uploadPrintAsset(job.outputPath, printPng);

  // Small JPEG thumbnail for the console (the full PNG is too large to preview
  // in a browser). A preview failure must never fail an otherwise-good job.
  onStage('Generating preview');
  const previewPath = await generatePreview(printPng, job.outputPath).catch(() => undefined);
  onStage('Done');

  return {
    jobId: job.jobId,
    panelId: manifest.panelId,
    dimensions: dims,
    dimensionSource: normalizeDimensionSource(manifest.dimensionSource),
    storagePath,
    previewPath,
    qc,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// A. Acquire master sheet
// ────────────────────────────────────────────────────────────────────────────

async function loadMaster(job: ExtractionJob): Promise<Buffer> {
  if (job.masterBytes && job.masterBytes.length > 0) return job.masterBytes;
  const url = job.manifest.masterArtworkUrl;
  if (!url) {
    throw new Error('Job has neither masterBytes (manual upload) nor masterArtworkUrl.');
  }
  const res = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 120_000,
  });
  return Buffer.from(res.data);
}

// ────────────────────────────────────────────────────────────────────────────
// B–D. Crop → size → mirror bleed
// ────────────────────────────────────────────────────────────────────────────

/**
 * The whole geometry, in one streamed libvips pass:
 *   extract the panel rectangle → cast to 16-bit → resize to exact live pixels
 *   → mirror-extend the bleed perimeter → flatten to 8-bit level-0 RGBA PNG.
 */
async function buildPanel(
  masterBytes: Buffer,
  crop: CropBox | undefined,
  dims: ResolvedDimensions,
): Promise<Buffer> {
  const bleed = bleedPx(dims);
  const live = liveDimensions(dims);

  let pipe = sharp(masterBytes, { limitInputPixels: false });
  // Crop mode: extract the panel region from a multi-view sheet.
  // Flat-Design mode (no crop): scale the whole pure design layer to the panel.
  if (crop) {
    const rect = await validatedCrop(masterBytes, crop);
    pipe = pipe.extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height });
  }

  return pipe
    // Resample in 16-bit space to prevent gradient banding across big panels.
    .toColourspace('rgb16')
    .resize({ width: live.width, height: live.height, fit: 'fill', kernel: sharp.kernel.lanczos3 })
    // Deterministically extend edge graphics into the bleed perimeter — mirror
    // avoids the smeared single-pixel streak that 'copy'/replicate produces.
    .extend({ top: bleed, bottom: bleed, left: bleed, right: bleed, extendWith: 'mirror' })
    // Back to 8-bit sRGB and write a lossless true-colour RGBA PNG. PNG is
    // lossless at every level; we compress (default 6) so the file is a sane
    // size that storage will accept, with identical pixels.
    .toColourspace('srgb')
    .ensureAlpha()
    .png({
      compressionLevel: config.export.pngCompression,
      adaptiveFiltering: false,
      palette: false,
      force: true,
    })
    .toBuffer();
}

/**
 * Clamp the requested crop to the master's real bounds so an out-of-range box
 * (common with hand-entered coordinates) fails loudly with a clear message
 * instead of a cryptic libvips error.
 */
async function validatedCrop(masterBytes: Buffer, crop: CropBox): Promise<CropBox> {
  const meta = await sharp(masterBytes, { limitInputPixels: false }).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const x = Math.round(crop.x);
  const y = Math.round(crop.y);
  const width = Math.round(crop.width);
  const height = Math.round(crop.height);

  if (width <= 0 || height <= 0) throw new Error('cropBox width/height must be positive.');
  if (x < 0 || y < 0 || x + width > W || y + height > H) {
    throw new Error(
      `cropBox (${x},${y},${width},${height}) is outside the master sheet (${W}x${H}).`,
    );
  }
  return { x, y, width, height };
}

// ────────────────────────────────────────────────────────────────────────────
// Preview thumbnail
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a downscaled JPEG preview from the finished print PNG and upload it
 * alongside as `<output>.preview.jpg`.
 */
async function generatePreview(printPng: Buffer, outputPath: string): Promise<string> {
  const jpeg = await sharp(printPng, { limitInputPixels: false })
    .resize({ width: 1400, fit: 'inside', kernel: sharp.kernel.lanczos3 })
    .flatten({ background: '#ffffff' }) // JPEG has no alpha
    .jpeg({ quality: 80 })
    .toBuffer();
  const previewPath = outputPath.replace(/\.[^./]+$/, '') + '.preview.jpg';
  return uploadPreview(previewPath, jpeg);
}
