/**
 * templateKey.ts — deterministic vehicle-template color-key.
 *
 * Strips the gray truck lines, windows, wheels, and the white background out of
 * a flat 2D proof region, keeping only the saturated wrap artwork — on
 * transparency. No AI. Two passes:
 *
 *   A. Flood-fill the connected near-white BACKGROUND from the borders → clear.
 *      (Interior white — e.g. the flag's white stripes — is preserved because
 *      it isn't connected to the border.)
 *   B. Clear low-saturation "gray/dark" template pixels (windows, wheels,
 *      outlines), while keeping bright whites and all saturated colors.
 *
 * Honest limits: areas hidden behind windows/wheels become transparent holes
 * (there's no artwork under them to recover), and shaded near-grays may need
 * threshold tuning (KEY_* env vars). It is deterministic and lossless on the
 * pixels it keeps.
 */

import sharp from 'sharp';
import { config } from './config.js';

export async function keyOutTemplate(pngBuffer: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(pngBuffer, { limitInputPixels: false })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const ch = info.channels; // 4
  const whiteT = config.key.whiteThreshold;
  const satT = config.key.satThreshold;
  const grayMax = config.key.grayMaxLightness;

  const isNearWhite = (o: number): boolean =>
    data[o]! >= whiteT && data[o + 1]! >= whiteT && data[o + 2]! >= whiteT;

  // ── A. Flood-fill the border-connected white background → alpha 0 ───────────
  const cleared = new Uint8Array(w * h);
  const stack: number[] = [];
  const consider = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = y * w + x;
    if (cleared[p]) return;
    if (isNearWhite(p * ch)) {
      cleared[p] = 1;
      stack.push(x, y);
    }
  };
  for (let x = 0; x < w; x++) {
    consider(x, 0);
    consider(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    consider(0, y);
    consider(w - 1, y);
  }
  while (stack.length) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    consider(x + 1, y);
    consider(x - 1, y);
    consider(x, y + 1);
    consider(x, y - 1);
  }

  // ── B. Clear gray/dark template pixels + apply the background mask ──────────
  let keptColor = 0;
  for (let p = 0; p < w * h; p++) {
    const o = p * ch;
    if (cleared[p]) {
      data[o + 3] = 0;
      continue;
    }
    const r = data[o]!;
    const g = data[o + 1]!;
    const b = data[o + 2]!;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max - min;
    // Low saturation AND not a bright white = gray/dark template → clear.
    if (sat <= satT && max < grayMax) {
      data[o + 3] = 0;
    } else {
      keptColor++;
    }
  }

  if (keptColor === 0) {
    throw new Error(
      'Template color-key removed everything — the crop may not contain saturated artwork, or thresholds need tuning (KEY_SAT_THRESHOLD / KEY_WHITE_THRESHOLD).',
    );
  }

  return sharp(data, { raw: { width: w, height: h, channels: 4 }, limitInputPixels: false })
    .png({ compressionLevel: config.export.pngCompression, force: true })
    .toBuffer();
}
