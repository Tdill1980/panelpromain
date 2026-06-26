/**
 * Shared contract types for the flat-sheet extraction pipeline.
 *
 * RestylePro/DesignProAI exports a single master proof PNG containing every
 * panel laid out flat. A job crops one rectangular panel region from that
 * sheet, sizes it to exact print pixels, and mirror-extends the bleed. No
 * perspective math, no boundary guessing — pure deterministic rectangles.
 */

/**
 * Provenance of the physical sizing metadata, surfaced on the operator console
 * as a verification tag. `database`/`csv` are trusted (green); everything else
 * is an unverified/fallback path (⚠️) the operator should eyeball.
 */
export type DimensionSource = 'database' | 'csv' | 'manual' | 'fallback' | 'unverified';

/**
 * A rectangular crop region into the master proof sheet, in master-pixel space.
 * This is the panel boundary — delivered by RestylePro (automated) or entered by
 * the operator (manual backup).
 */
export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Physical dimensions of the destination panel. These — not any model — decide
 * the output canvas size via absolute pixel math (see sizing.ts).
 */
export interface PanelPhysical {
  /** Finished panel width in inches (excludes bleed). */
  widthInches: number;
  /** Finished panel height in inches (excludes bleed). */
  heightInches: number;
  /** Output resolution; defaults to 150 if omitted. */
  dpi?: number;
  /** Per-edge bleed in inches; defaults to 5 if omitted. */
  bleedInches?: number;
}

/**
 * The structural manifest emitted by RestylePro. Companion to the master proof
 * sheet; carries the panel crop box and physical sizing. Fully deterministic.
 */
export interface PanelManifest {
  panelId: string;
  /**
   * URL of the master proof sheet (downloaded via axios). Optional: omitted on
   * the manual-upload route, where the sheet is delivered as a raw buffer.
   */
  masterArtworkUrl?: string;
  physical: PanelPhysical;
  /**
   * Rectangular panel region to crop from a multi-view master sheet.
   * OMIT for Flat-Design mode: when absent, the whole uploaded design layer is
   * scaled to the panel (no crop) — the correct path for a pure artboard asset.
   */
  cropBox?: CropBox;
  /** Where the physical sizing came from. Defaults to 'unverified' if absent. */
  dimensionSource?: DimensionSource;
}

/** Fully resolved destination geometry derived from {@link PanelPhysical}. */
export interface ResolvedDimensions {
  dpi: number;
  bleedInches: number;
  /** Total output width in pixels, including bleed on both edges. */
  targetWidthPx: number;
  /** Total output height in pixels, including bleed on both edges. */
  targetHeightPx: number;
}

/** Inbound webhook job payload. */
export interface ExtractionJob {
  jobId: string;
  manifest: PanelManifest;
  /** Destination object path inside the Supabase Storage bucket. */
  outputPath: string;
  /**
   * Raw master sheet bytes for the manual-upload backup route. When present,
   * the pipeline ingests these directly and skips the RestylePro URL fetch.
   */
  masterBytes?: Buffer;
  /** Provenance of the master raster, for audit logging. */
  source?: 'restylepro-url' | 'manual-upload';
}

/** Result of a single QC metric evaluation. */
export interface QcMetric {
  name: string;
  value: number;
  threshold: number;
  /** True when the metric is within tolerance. */
  passed: boolean;
  detail?: string;
}

/** Aggregate QC verdict. A single failed metric fails the whole gate. */
export interface QcReport {
  passed: boolean;
  metrics: QcMetric[];
}

/** Final pipeline outcome returned by the processor. */
export interface ExtractionResult {
  jobId: string;
  panelId: string;
  dimensions: ResolvedDimensions;
  /** Provenance of the sizing that produced {@link dimensions}. */
  dimensionSource: DimensionSource;
  /** Public/object path written to Supabase Storage. */
  storagePath: string;
  /** Object path of the small JPEG preview thumbnail, if one was generated. */
  previewPath?: string;
  qc: QcReport;
}
