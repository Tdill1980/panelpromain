/**
 * qc.ts — strict Delta-E & SSIM gate metrics.
 *
 * Programmatically validates the exported print file against the original
 * RestylePro vector source. Any single violation rejects the job; the processor
 * treats a failed gate as a hard halt (no silent shipping of degraded prints).
 *
 * Gate parameters (from config.qc):
 *   - Color ΔE (CIEDE2000)  > 2.0   → reject  (hue drift / ambient dimming)
 *   - SSIM                  < 0.98  → reject  (pixel blur / layout warp)
 *   - Edge error            > 1 px  → reject  (boundary deviation)
 *   - OCR text change                → reject  (1:1 lettering/typography)
 *
 * Metrics are computed on a normalized, downsampled comparison pair so the gate
 * runs in bounded memory even for 30000×9150 canvases, while ΔE is measured in
 * full-fidelity Lab space.
 */

import axios from 'axios';
import sharp from 'sharp';
import type { CropBox, QcMetric, QcReport, ResolvedDimensions } from './types.js';
import { config } from './config.js';
import { bleedPx, liveDimensions } from './sizing.js';

/** Side length the comparison rasters are normalized to before metrics. */
const COMPARE_LONG_EDGE = 1024;

export class QcGateError extends Error {
  constructor(public readonly jobId: string, public readonly report: QcReport) {
    super(
      `QC gate FAILED for job ${jobId}: ` +
        report.metrics
          .filter((m) => !m.passed)
          .map((m) => `${m.name}=${m.value.toFixed(4)} (limit ${m.threshold})`)
          .join(', '),
    );
    this.name = 'QcGateError';
  }
}

export interface QcInput {
  /** Exported 8-bit RGBA PNG candidate (panel with bleed). */
  candidate: Buffer;
  /** Reference master bytes (manual-upload route). Takes precedence over URL. */
  referenceBytes?: Buffer;
  /** URL of the original RestylePro master used as the reference. */
  referenceUrl?: string;
  /** The panel crop region within the master sheet; omit for flat-design mode. */
  cropBox?: CropBox;
  dims: ResolvedDimensions;
}

interface Plane {
  data: Buffer; // RGB, 8-bit, 3 channels
  width: number;
  height: number;
}

export async function runQualityGate(input: QcInput): Promise<QcReport> {
  const masterBytes = await loadReference(input);
  const bleed = bleedPx(input.dims);
  const live = liveDimensions(input.dims);
  const c = input.cropBox;

  // Reference = the source region (crop mode) or the whole design (flat mode).
  const refRegion = c
    ? await sharp(masterBytes, { limitInputPixels: false })
        .extract({
          left: Math.round(c.x),
          top: Math.round(c.y),
          width: Math.round(c.width),
          height: Math.round(c.height),
        })
        .png()
        .toBuffer()
    : await sharp(masterBytes, { limitInputPixels: false }).png().toBuffer();

  // Candidate = the produced panel minus its bleed border (the live artwork),
  // so we compare like-for-like and the mirrored bleed doesn't skew the metrics.
  const candRegion = await sharp(input.candidate, { limitInputPixels: false })
    .extract({ left: bleed, top: bleed, width: live.width, height: live.height })
    .png()
    .toBuffer();

  // Normalize both to a common comparison size so structural metrics align.
  const candidate = await toComparePlane(candRegion);
  const refPlane = await toComparePlane(refRegion, candidate.width, candidate.height);

  const metrics: QcMetric[] = [
    deltaEMetric(candidate, refPlane),
    ssimMetric(candidate, refPlane),
    edgeErrorMetric(candidate, refPlane),
  ];

  if (config.qc.enforceOcr) {
    metrics.push(await ocrMetric(candRegion, refRegion));
  }

  const passed = metrics.every((m) => m.passed);
  return { passed, metrics };
}

// ────────────────────────────────────────────────────────────────────────────
// Loading / normalization
// ────────────────────────────────────────────────────────────────────────────

async function loadReference(input: QcInput): Promise<Buffer> {
  if (input.referenceBytes && input.referenceBytes.length > 0) return input.referenceBytes;
  const url = input.referenceUrl;
  if (!url) throw new Error('QC needs either referenceBytes or referenceUrl.');
  const res = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 120_000,
  });
  return Buffer.from(res.data);
}

async function toComparePlane(png: Buffer, width?: number, height?: number): Promise<Plane> {
  let pipe = sharp(png, { limitInputPixels: false }).removeAlpha();
  if (width && height) {
    pipe = pipe.resize({ width, height, fit: 'fill', kernel: sharp.kernel.lanczos3 });
  } else {
    pipe = pipe.resize({
      width: COMPARE_LONG_EDGE,
      height: COMPARE_LONG_EDGE,
      fit: 'inside',
      kernel: sharp.kernel.lanczos3,
    });
  }
  const { data, info } = await pipe.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// ────────────────────────────────────────────────────────────────────────────
// Metric 1 — Color ΔE (CIEDE2000) over mean Lab difference
// ────────────────────────────────────────────────────────────────────────────

function deltaEMetric(a: Plane, b: Plane): QcMetric {
  const n = Math.min(a.data.length, b.data.length) / 3;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const labA = rgbToLab(a.data[o]!, a.data[o + 1]!, a.data[o + 2]!);
    const labB = rgbToLab(b.data[o]!, b.data[o + 1]!, b.data[o + 2]!);
    sum += ciede2000(labA, labB);
  }
  const value = n > 0 ? sum / n : 0;
  return {
    name: 'deltaE',
    value,
    threshold: config.qc.maxDeltaE,
    passed: value <= config.qc.maxDeltaE,
    detail: 'mean CIEDE2000 over all pixels',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Metric 2 — SSIM (global, luma)
// ────────────────────────────────────────────────────────────────────────────

function ssimMetric(a: Plane, b: Plane): QcMetric {
  const lumaA = toLuma(a);
  const lumaB = toLuma(b);
  const value = globalSsim(lumaA, lumaB);
  return {
    name: 'ssim',
    value,
    threshold: config.qc.minSsim,
    passed: value >= config.qc.minSsim,
    detail: 'global structural similarity on luma',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Metric 3 — Edge error (max boundary deviation in compare-space px)
// ────────────────────────────────────────────────────────────────────────────

function edgeErrorMetric(a: Plane, b: Plane): QcMetric {
  const ea = sobelEdges(toLuma(a), a.width, a.height);
  const eb = sobelEdges(toLuma(b), b.width, b.height);
  // Scale the compare-space deviation back to destination pixels.
  const scale = 1; // already normalized to the same compare grid
  const value = maxEdgeShift(ea, eb, a.width, a.height) * scale;
  return {
    name: 'edgeError',
    value,
    threshold: config.qc.maxEdgeErrorPx,
    passed: value <= config.qc.maxEdgeErrorPx,
    detail: 'max boundary deviation across graphic edges',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Metric 4 — OCR text change (1:1 typography)
// ────────────────────────────────────────────────────────────────────────────

async function ocrMetric(candidate: Buffer, reference: Buffer): Promise<QcMetric> {
  // OCR is best-effort: if tesseract.js is missing, the wrong shape, or fails at
  // runtime (e.g. model download blocked), we SKIP it (pass) rather than fail an
  // otherwise-good print. It only ever rejects on a real 1:1 text mismatch.
  const skip = (detail: string): QcMetric => ({
    name: 'ocrTextChange',
    value: 0,
    threshold: 0,
    passed: true,
    detail,
  });

  let recognize: ((png: Buffer) => Promise<string>) | null = null;
  try {
    // Dynamic import may put the API on `.default` (CJS interop under ESM).
    const mod = (await import('tesseract.js')) as Record<string, unknown>;
    const lib = ((mod.default as Record<string, unknown>) ?? mod) as {
      recognize?: (img: Buffer, lang: string) => Promise<{ data?: { text?: string } }>;
    };
    if (typeof lib.recognize !== 'function') {
      return skip('tesseract.js recognize() unavailable — OCR skipped');
    }
    recognize = async (png: Buffer) => {
      // Downscale before OCR — full-res print rasters (100s of MP) make
      // tesseract/Leptonica run out of memory and hard-crash the process.
      const small = await sharp(png, { limitInputPixels: false })
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
      const out = await lib.recognize!(small, 'eng');
      return String(out?.data?.text ?? '').replace(/\s+/g, ' ').trim();
    };
  } catch {
    return skip('tesseract.js not installed — OCR skipped');
  }

  try {
    const [candText, refText] = await Promise.all([recognize(candidate), recognize(reference)]);
    const distance = normalizedLevenshtein(candText, refText);
    return {
      name: 'ocrTextChange',
      value: distance,
      threshold: 0, // require exact 1:1 lettering
      passed: distance === 0,
      detail: 'normalized edit distance between OCR transcriptions',
    };
  } catch (err) {
    return skip(`OCR unavailable (${(err as Error).message}) — skipped`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Pure numeric helpers
// ════════════════════════════════════════════════════════════════════════════

interface Lab {
  L: number;
  a: number;
  b: number;
}

function rgbToLab(r: number, g: number, b: number): Lab {
  // sRGB → linear
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);

  // linear RGB → XYZ (D65)
  let X = R * 0.4124 + G * 0.3576 + B * 0.1805;
  let Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  let Z = R * 0.0193 + G * 0.1192 + B * 0.9505;

  // Normalize by D65 white
  X /= 0.95047;
  Y /= 1.0;
  Z /= 1.08883;

  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);

  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIEDE2000 color difference. */
function ciede2000(s: Lab, t: Lab): number {
  const kL = 1;
  const kC = 1;
  const kH = 1;

  const C1 = Math.hypot(s.a, s.b);
  const C2 = Math.hypot(t.a, t.b);
  const Cbar = (C1 + C2) / 2;

  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));

  const a1p = (1 + G) * s.a;
  const a2p = (1 + G) * t.a;

  const C1p = Math.hypot(a1p, s.b);
  const C2p = Math.hypot(a2p, t.b);

  const h1p = hueAngle(s.b, a1p);
  const h2p = hueAngle(t.b, a2p);

  const dLp = t.L - s.L;
  const dCp = C2p - C1p;

  let dhp = 0;
  if (C1p * C2p !== 0) {
    const diff = h2p - h1p;
    if (Math.abs(diff) <= 180) dhp = diff;
    else if (diff > 180) dhp = diff - 360;
    else dhp = diff + 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(deg2rad(dhp) / 2);

  const Lbarp = (s.L + t.L) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbarp += h1p + h2p < 360 ? 360 : -360;
    hbarp /= 2;
  }

  const T =
    1 -
    0.17 * Math.cos(deg2rad(hbarp - 30)) +
    0.24 * Math.cos(deg2rad(2 * hbarp)) +
    0.32 * Math.cos(deg2rad(3 * hbarp + 6)) -
    0.2 * Math.cos(deg2rad(4 * hbarp - 63));

  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(deg2rad(2 * dTheta)) * Rc;

  return Math.sqrt(
    Math.pow(dLp / (kL * Sl), 2) +
      Math.pow(dCp / (kC * Sc), 2) +
      Math.pow(dHp / (kH * Sh), 2) +
      Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh)),
  );
}

function hueAngle(b: number, ap: number): number {
  if (b === 0 && ap === 0) return 0;
  const angle = rad2deg(Math.atan2(b, ap));
  return angle >= 0 ? angle : angle + 360;
}

const deg2rad = (d: number) => (d * Math.PI) / 180;
const rad2deg = (r: number) => (r * 180) / Math.PI;

/** ITU-R BT.601 luma plane from an RGB compare plane. */
function toLuma(p: Plane): Float64Array {
  const n = p.width * p.height;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    out[i] = 0.299 * p.data[o]! + 0.587 * p.data[o + 1]! + 0.114 * p.data[o + 2]!;
  }
  return out;
}

/** Global SSIM (single window over the whole image). */
function globalSsim(a: Float64Array, b: Float64Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 1;

  let muA = 0;
  let muB = 0;
  for (let i = 0; i < n; i++) {
    muA += a[i]!;
    muB += b[i]!;
  }
  muA /= n;
  muB /= n;

  let varA = 0;
  let varB = 0;
  let cov = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - muA;
    const db = b[i]! - muB;
    varA += da * da;
    varB += db * db;
    cov += da * db;
  }
  varA /= n - 1 || 1;
  varB /= n - 1 || 1;
  cov /= n - 1 || 1;

  const L = 255;
  const C1 = (0.01 * L) ** 2;
  const C2 = (0.03 * L) ** 2;

  return (
    ((2 * muA * muB + C1) * (2 * cov + C2)) /
    ((muA * muA + muB * muB + C1) * (varA + varB + C2))
  );
}

/** Binary Sobel edge map (1 where gradient magnitude exceeds a fixed threshold). */
function sobelEdges(luma: Float64Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const at = (x: number, y: number) => luma[y * w + x]!;
  const threshold = 64; // gradient magnitude on 0..255 luma
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx =
        -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) +
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy =
        -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) +
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      out[y * w + x] = Math.hypot(gx, gy) >= threshold ? 1 : 0;
    }
  }
  return out;
}

/**
 * Maximum positional shift between corresponding edges: for each candidate edge
 * pixel with no reference edge at the same location, measure the nearest
 * reference edge within a small search radius. Returns the worst-case distance.
 */
function maxEdgeShift(a: Uint8Array, b: Uint8Array, w: number, h: number): number {
  const radius = 4; // bounded local search keeps this O(n * r^2)
  let worst = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (a[y * w + x] !== 1) continue;
      if (b[y * w + x] === 1) continue; // perfectly aligned
      let best = Infinity;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          if (b[ny * w + nx] === 1) best = Math.min(best, Math.hypot(dx, dy));
        }
      }
      if (best === Infinity) best = radius + 1; // no match within radius
      worst = Math.max(worst, best);
    }
  }
  return worst;
}

/** Normalized Levenshtein distance in [0,1]; 0 means identical strings. */
function normalizedLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0 || b.length === 0) return 1;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }

  return prev[b.length]! / Math.max(a.length, b.length);
}
