/**
 * Absolute sizing & precision math (RestylePro compatible).
 *
 * CRITICAL INVARIANT: output size is resolved deterministically from physical
 * panel data here, and nowhere else.
 *
 *   targetWidthPx  = round((widthInches  + bleed * 2) * dpi)
 *   targetHeightPx = round((heightInches + bleed * 2) * dpi)
 *
 * Reference: a 190" x 51" panel @ 150 DPI with 5" bleed → exactly 30000 x 9150.
 */

import { config } from './config';
import type { DimensionSource, PanelPhysical, ResolvedDimensions } from './types';

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

/** Bleed thickness expressed in destination pixels (per edge). */
export function bleedPx(dims: ResolvedDimensions): number {
  return Math.round(dims.bleedInches * dims.dpi);
}

/** The "live" panel area in pixels, i.e. the artwork excluding the bleed border. */
export function liveDimensions(dims: ResolvedDimensions): { width: number; height: number } {
  const b = bleedPx(dims);
  return { width: dims.targetWidthPx - 2 * b, height: dims.targetHeightPx - 2 * b };
}

const DIMENSION_SOURCES: readonly DimensionSource[] = [
  'database',
  'csv',
  'manual',
  'fallback',
  'unverified',
];

/** Coerce arbitrary input to a valid {@link DimensionSource}, defaulting safe. */
export function normalizeDimensionSource(value: unknown): DimensionSource {
  return DIMENSION_SOURCES.includes(value as DimensionSource)
    ? (value as DimensionSource)
    : 'unverified';
}
