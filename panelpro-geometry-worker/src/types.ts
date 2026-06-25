/**
 * Shared contract types for the Panel-First extraction pipeline.
 *
 * Everything geometric is driven by the structural manifest that RestylePro
 * exports alongside the flat master artwork. The worker NEVER infers boundaries
 * from pixels — these types are the single source of truth for layout.
 */

/** A 2D point in source-canvas pixel space (RestylePro design coordinates). */
export interface Point {
  x: number;
  y: number;
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
 * The four source-canvas corners that map onto the destination rectangle.
 * Order is fixed: top-left, top-right, bottom-right, bottom-left.
 */
export type CornerQuad = [Point, Point, Point, Point];

/**
 * An occlusion region — a physically hidden void on the vehicle/substrate
 * (door handle, mirror mount, wheel arch) expressed as a closed polygon in
 * DESTINATION pixel space. These are the ONLY areas AI is allowed to touch.
 */
export interface OcclusionPolygon {
  id: string;
  /** Human label, e.g. "driver-door-handle". Used for audit logging only. */
  label?: string;
  /** Closed polygon ring in destination pixel coordinates. */
  points: Point[];
}

/**
 * The structural manifest emitted by RestylePro. Companion to the flat master
 * artwork; carries crop geometry and occlusion data. Fully deterministic.
 */
export interface PanelManifest {
  panelId: string;
  /**
   * URL of the raw, flattened master design canvas (downloaded via axios).
   * Optional: omitted on the manual-upload backup route, where the master is
   * delivered as a raw buffer instead (see {@link ExtractionJob.masterBytes}).
   */
  masterArtworkUrl?: string;
  physical: PanelPhysical;
  /**
   * Source-canvas quad that defines the crop/warp. Mapped directly onto the
   * computed destination rectangle via findHomography → warpPerspective.
   */
  sourceQuad: CornerQuad;
  /** Voids to be repaired by sub-surface inpainting. May be empty. */
  occlusions?: OcclusionPolygon[];
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
   * Raw master artwork bytes for the manual-upload backup route. When present,
   * the pipeline ingests these directly and skips the RestylePro URL fetch —
   * the deterministic geometry is otherwise identical.
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
  /** Public/object path written to Supabase Storage. */
  storagePath: string;
  qc: QcReport;
  /** Number of occluded voids repaired by AI (0 when none present). */
  inpaintedVoids: number;
}
