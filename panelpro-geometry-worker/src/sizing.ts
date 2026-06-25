/**
 * Absolute sizing & precision math (RestylePro compatible).
 *
 * CRITICAL INVARIANT: no AI or vision model is ever permitted to choose canvas
 * dimensions. Output size is resolved deterministically from physical panel
 * data here, and nowhere else.
 *
 *   targetWidthPx  = round((widthInches  + bleed * 2) * dpi)
 *   targetHeightPx = round((heightInches + bleed * 2) * dpi)
 *
 * Reference: a 190" x 51" panel @ 150 DPI with 5" bleed → exactly 30000 x 9150.
 */

import { config } from './config';
import type { PanelPhysical, ResolvedDimensions } from './types';

export function resolveDimensions(physical: PanelPhysical): ResolvedDimensions {
  const dpi = physical.dpi ?? config.geometry.defaultDpi;
  const bleedInches = physical.bleedInches ?? config.geometry.defaultBleedInches;

  if (physical.widthInches <= 0 || physical.heightInches <= 0) {
    throw new Error('Panel dimensions must be positive inches.');
  }
  if (dpi <= 0) throw new Error('DPI must be positive.');
  if (bleedInches < 0) throw new Error('Bleed cannot be negative.');

  const targetWidthPx = Math.round((physical.widthInches + bleedInches * 2) * dpi);
  const targetHeightPx = Math.round((physical.heightInches + bleedInches * 2) * dpi);

  return { dpi, bleedInches, targetWidthPx, targetHeightPx };
}

/** Bleed thickness expressed in destination pixels (for masking the perimeter). */
export function bleedPx(dims: ResolvedDimensions): number {
  return Math.round(dims.bleedInches * dims.dpi);
}
