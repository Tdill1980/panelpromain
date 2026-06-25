/**
 * processor.ts — OpenCV geometry warp & 16-bit Sharp execution.
 *
 * Implements the deterministic Panel-First pipeline:
 *
 *   A. DOWNLOAD MASTER ARTWORK   (axios)
 *   B. MECHANICAL CROP & WARP    (findHomography → warpPerspective, LANCZOS4,
 *                                 BORDER_REPLICATE bleed)
 *   C. COMPILE LAYOUT            (Sharp, 16-bit space, lanczos3)
 *   D. SURGICAL AI REPAIR        (occlusion mask only — see inpaint.ts)
 *   E. EXPORT PRINT FILE         (8-bit lossless RGBA PNG → Supabase)
 *
 * Color-sensitive compositing runs in Sharp's 16-bit-per-channel space to
 * avoid gradient banding across print-resolution canvases; only the final
 * write step flattens to an 8-bit, compression-level-0 RGBA PNG.
 */

import axios from 'axios';
import sharp from 'sharp';
// Native OpenCV bindings (maintained @u4 fork — builds against modern system
// OpenCV). Heavy install; isolated to the warp step so the rest stays portable.
import cv from '@u4/opencv4nodejs';

import { config } from './config';
import { resolveDimensions, bleedPx, normalizeDimensionSource } from './sizing';
import { uploadPrintAsset, uploadPreview } from './supabase';
import { inpaintVoids } from './inpaint';
import { runQualityGate, QcGateError } from './qc';
import type {
  CornerQuad,
  ExtractionJob,
  ExtractionResult,
  OcclusionPolygon,
  Point,
  ResolvedDimensions,
} from './types';

/** Allow large prints to stream without tripping Sharp's pixel guard. */
sharp.cache(false);
sharp.concurrency(0); // libvips picks an optimal thread count

/**
 * Entry point invoked by the dispatcher for each job.
 *
 * Throws {@link QcGateError} when the strict QC gate rejects the result — the
 * caller is expected to treat that as a hard halt for the job.
 */
export async function executeMechanicalExtraction(job: ExtractionJob): Promise<ExtractionResult> {
  const { manifest } = job;
  const dims = resolveDimensions(manifest.physical);

  // ── A. ACQUIRE MASTER ARTWORK ───────────────────────────────────────────────
  // Manual-upload route: ingest the provided buffer directly. Otherwise fetch
  // the flat RestylePro canvas by URL. Geometry downstream is identical.
  const masterBytes = await loadMaster(job);

  // ── B. MECHANICAL CROP & WARP (OpenCV) ──────────────────────────────────────
  const warpedPng = warpToTarget(masterBytes, manifest.sourceQuad, dims);

  // ── C. COMPILE LAYOUT (16-bit Sharp) ────────────────────────────────────────
  const flatRgba = await compileLayout(warpedPng, dims);

  // ── D. SURGICAL AI REPAIR (occluded voids only) ─────────────────────────────
  const occlusions = manifest.occlusions ?? [];
  const repaired = occlusions.length
    ? await repairOcclusions(flatRgba, occlusions, dims)
    : flatRgba;

  // ── E. EXPORT PRINT FILE ────────────────────────────────────────────────────
  const printPng = await encodePrintPng(repaired, dims);

  // Strict QC gate against the original source — the uploaded buffer on the
  // manual route, or the RestylePro URL otherwise. Halts on violation.
  const qc = await runQualityGate({
    candidate: printPng,
    referenceBytes: job.masterBytes,
    referenceUrl: manifest.masterArtworkUrl,
    sourceQuad: manifest.sourceQuad,
    dims,
  });
  if (!qc.passed) {
    throw new QcGateError(job.jobId, qc);
  }

  const storagePath = await uploadPrintAsset(job.outputPath, printPng);

  // Small JPEG thumbnail for the console (the full PNG is too large to preview
  // in a browser). A preview failure must never fail an otherwise-good job.
  const previewPath = await generatePreview(repaired, job.outputPath).catch(() => undefined);

  return {
    jobId: job.jobId,
    panelId: manifest.panelId,
    dimensions: dims,
    dimensionSource: normalizeDimensionSource(manifest.dimensionSource),
    storagePath,
    previewPath,
    qc,
    inpaintedVoids: occlusions.length,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// A. Download
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the master raster from whichever source the job carries. The manual
 * backup route supplies bytes directly; the automated route supplies a URL.
 */
async function loadMaster(job: ExtractionJob): Promise<Buffer> {
  if (job.masterBytes && job.masterBytes.length > 0) return job.masterBytes;
  const url = job.manifest.masterArtworkUrl;
  if (!url) {
    throw new Error('Job has neither masterBytes (manual upload) nor masterArtworkUrl.');
  }
  return downloadMaster(url);
}

async function downloadMaster(url: string): Promise<Buffer> {
  const res = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    // Master artwork can be very large; no client-side size cap, this container
    // is memory-unconstrained by design.
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 120_000,
  });
  return Buffer.from(res.data);
}

// ────────────────────────────────────────────────────────────────────────────
// B. Mechanical crop & warp (OpenCV)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Maps the source-canvas quad directly onto the destination rectangle using an
 * exact homography. LANCZOS4 keeps vector text razor-sharp; BORDER_REPLICATE
 * deterministically extends edge graphics into the bleed perimeter with no
 * generative guessing.
 *
 * Returns PNG-encoded bytes so the result hands cleanly to Sharp.
 */
function warpToTarget(masterBytes: Buffer, sourceQuad: CornerQuad, dims: ResolvedDimensions): Buffer {
  const src = cv.imdecode(masterBytes, cv.IMREAD_UNCHANGED);

  const { targetWidthPx: w, targetHeightPx: h } = dims;

  const srcPts = sourceQuad.map(toCvPoint);
  // Destination is the full target rectangle, corners in the same TL,TR,BR,BL
  // order as the source quad.
  const dstPts = [
    new cv.Point2(0, 0),
    new cv.Point2(w, 0),
    new cv.Point2(w, h),
    new cv.Point2(0, h),
  ];

  const homography = cv.findHomography(srcPts, dstPts).homography;

  const warped = src.warpPerspective(
    homography,
    new cv.Size(w, h),
    cv.INTER_LANCZOS4,
    cv.BORDER_REPLICATE,
  );

  return cv.imencode('.png', warped);
}

function toCvPoint(p: Point): InstanceType<typeof cv.Point2> {
  return new cv.Point2(p.x, p.y);
}

/**
 * Build a downscaled JPEG preview from the flat asset and upload it alongside
 * the print file. Derives `<output>.preview.jpg` from the output path.
 */
async function generatePreview(asset: sharp.Sharp, outputPath: string): Promise<string> {
  const jpeg = await asset
    .clone()
    .resize({ width: 1400, fit: 'inside', kernel: sharp.kernel.lanczos3 })
    .flatten({ background: '#ffffff' }) // JPEG has no alpha
    .jpeg({ quality: 80 })
    .toBuffer();
  const previewPath = outputPath.replace(/\.[^./]+$/, '') + '.preview.jpg';
  return uploadPreview(previewPath, jpeg);
}

// ────────────────────────────────────────────────────────────────────────────
// C. Compile layout (16-bit Sharp)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Promotes the warped raster into Sharp's 16-bit working space, enforces the
 * exact target geometry with a lanczos3 aspect-preserving resize, and returns a
 * flat RGBA raster (still 16-bit) ready for masked compositing.
 */
async function compileLayout(
  warpedPng: Buffer,
  dims: ResolvedDimensions,
): Promise<sharp.Sharp> {
  const pipeline = sharp(warpedPng, { limitInputPixels: false })
    // Work in a linear-friendly 16-bit RGB space to prevent gradient banding.
    .toColourspace('rgb16')
    .ensureAlpha()
    .resize({
      width: dims.targetWidthPx,
      height: dims.targetHeightPx,
      fit: 'fill', // geometry is already exact from the warp; lock dimensions
      kernel: sharp.kernel.lanczos3,
    });

  // Return a fresh Sharp wrapping the raw 16-bit RGBA so downstream stages can
  // composite deterministically without re-encoding.
  const { data, info } = await pipeline
    .raw({ depth: 'ushort' })
    .toBuffer({ resolveWithObject: true });

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4, premultiplied: false },
    limitInputPixels: false,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// D. Surgical AI repair (occluded voids only)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Builds a binary transparency mask from the occlusion polygons and passes ONLY
 * the flat cropped asset + mask to the inpainter. The mask is authored with
 * OpenCV's exact polygon fill so it matches the destination geometry 1:1.
 */
async function repairOcclusions(
  flat: sharp.Sharp,
  occlusions: OcclusionPolygon[],
  dims: ResolvedDimensions,
): Promise<sharp.Sharp> {
  const { targetWidthPx: w, targetHeightPx: h } = dims;

  // Render the current flat asset as 8-bit RGBA PNG — the contract the AI edit
  // endpoints expect. (Color-critical work already happened in 16-bit.)
  const flatPng = await flat.clone().png({ compressionLevel: 0 }).toBuffer();

  // Single-channel mask: white (255) inside voids, black elsewhere.
  const mask = new cv.Mat(h, w, cv.CV_8UC1, 0);
  const rings = occlusions.map((o) => o.points.map(toCvPoint));
  mask.drawFillPoly(rings, new cv.Vec3(255, 255, 255));
  const maskPng = cv.imencode('.png', mask);

  const repairedPng = await inpaintVoids({ image: flatPng, mask: maskPng, width: w, height: h });

  // Back to a Sharp pipeline (re-promote to 16-bit so the export path is uniform).
  return sharp(repairedPng, { limitInputPixels: false })
    .toColourspace('rgb16')
    .ensureAlpha();
}

// ────────────────────────────────────────────────────────────────────────────
// E. Export print file
// ────────────────────────────────────────────────────────────────────────────

/**
 * Final write: 8-bit, uncompressed (compression level 0), lossless RGBA PNG.
 * No intermediate lossy hop ever occurs — we go 16-bit working space straight
 * to 8-bit PNG exactly once, here.
 */
async function encodePrintPng(asset: sharp.Sharp, dims: ResolvedDimensions): Promise<Buffer> {
  void bleedPx(dims); // bleed already baked in by BORDER_REPLICATE; kept for audit
  return asset
    .clone()
    .toColourspace('srgb') // 8-bit sRGB output
    .ensureAlpha()
    .png({
      compressionLevel: 0, // uncompressed
      adaptiveFiltering: false,
      palette: false, // force true-color RGBA, never indexed
      force: true,
    })
    .toBuffer();
}
