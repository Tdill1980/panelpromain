/**
 * Centralized, validated runtime configuration.
 *
 * Baseline geometric constants are intentionally hard-defaulted here so the
 * sizing math is reproducible even if the environment is misconfigured. The
 * panel manifest can still override DPI/bleed per job.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Env var ${name} must be numeric, got "${raw}"`);
  }
  return parsed;
}

function str(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export const config = {
  port: num('PORT', 8080),
  webhookSecret: str('WEBHOOK_SECRET'),

  supabase: {
    url: str('SUPABASE_URL'),
    serviceRoleKey: str('SUPABASE_SERVICE_ROLE_KEY'),
    bucket: str('SUPABASE_OUTPUT_BUCKET', 'print-assets'),
  },

  /**
   * Storage backend for finished print assets. Defaults to Supabase, but
   * switches to Cloudflare R2 automatically when R2 credentials are present —
   * R2 has no 50 MB free-plan cap, so full-resolution prints upload for free.
   */
  storage: {
    backend: (str('R2_ACCESS_KEY_ID') && str('R2_BUCKET') ? 'r2' : 'supabase') as 'r2' | 'supabase',
    r2: {
      accountId: str('R2_ACCOUNT_ID'),
      accessKeyId: str('R2_ACCESS_KEY_ID'),
      secretAccessKey: str('R2_SECRET_ACCESS_KEY'),
      bucket: str('R2_BUCKET'),
      // Defaults to the standard R2 S3 endpoint derived from the account id.
      endpoint:
        str('R2_ENDPOINT') ||
        (str('R2_ACCOUNT_ID') ? `https://${str('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com` : ''),
    },
  },

  /** RestylePro-compatible baseline constants. */
  geometry: {
    defaultDpi: num('DEFAULT_DPI', 150),
    defaultBleedInches: num('DEFAULT_BLEED_INCHES', 5),
  },

  /**
   * Strict QC gate thresholds. A violation halts the job (see qc.ts).
   * These are deliberately tight for pre-press fidelity.
   */
  qc: {
    maxDeltaE: num('QC_MAX_DELTAE', 2.0), // hue drift / ambient dimming
    minSsim: num('QC_MIN_SSIM', 0.98), // pixel blur / layout warp
    // Boundary deviation in downscaled compare-space px. 1px is unrealistic for
    // large upscales (resampling shifts edges ~1–2px); 3 catches real warping
    // while passing faithful crops. Tunable via env.
    maxEdgeErrorPx: num('QC_MAX_EDGE_PX', 3.0),
    // OCR is OFF by default: tesseract.js can crash the process on huge rasters
    // (Leptonica malloc fail) and the failure isn't catchable. Opt in only if
    // you've verified it on your content.
    enforceOcr: bool('ENFORCE_OCR', false), // 1:1 lettering/typography (best-effort)
  },

  export: {
    // PNG is LOSSLESS at every compression level — level 0 only bloats the file
    // (~1 GB at 30000×9150, which exceeds storage limits). Default to real
    // (still lossless) compression. 0–9; higher = smaller, more CPU.
    pngCompression: num('PNG_COMPRESSION', 6),
  },
} as const;

export type AppConfig = typeof config;

/**
 * Fail fast on startup if the connector secrets required to actually ship a
 * print file are missing. Geometry-only dry runs can skip this.
 */
export function assertRuntimeConfig(): void {
  const missing: string[] = [];
  if (config.storage.backend === 'r2') {
    if (!config.storage.r2.accountId && !config.storage.r2.endpoint) missing.push('R2_ACCOUNT_ID');
    if (!config.storage.r2.accessKeyId) missing.push('R2_ACCESS_KEY_ID');
    if (!config.storage.r2.secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY');
    if (!config.storage.r2.bucket) missing.push('R2_BUCKET');
  } else {
    if (!config.supabase.url) missing.push('SUPABASE_URL');
    if (!config.supabase.serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  }
  if (missing.length) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }
}
