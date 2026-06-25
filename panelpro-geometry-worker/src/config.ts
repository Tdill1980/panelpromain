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

export const config = {
  port: num('PORT', 8080),
  webhookSecret: str('WEBHOOK_SECRET'),

  supabase: {
    url: str('SUPABASE_URL'),
    serviceRoleKey: str('SUPABASE_SERVICE_ROLE_KEY'),
    bucket: str('SUPABASE_OUTPUT_BUCKET', 'print-assets'),
  },

  /** RestylePro-compatible baseline constants. */
  geometry: {
    defaultDpi: num('DEFAULT_DPI', 150),
    defaultBleedInches: num('DEFAULT_BLEED_INCHES', 5),
  },

  /** Sub-surface inpainting. Empty provider => AI fully disabled. */
  inpaint: {
    provider: str('INPAINT_PROVIDER') as 'gemini' | 'openai' | '',
    apiKey: str('INPAINT_API_KEY'),
    temperature: num('INPAINT_TEMPERATURE', 0.0),
  },

  /**
   * Strict QC gate thresholds. A violation halts the job (see qc.ts).
   * These are deliberately tight for pre-press fidelity.
   */
  qc: {
    maxDeltaE: 2.0, // hue drift / ambient dimming
    minSsim: 0.98, // pixel blur / layout warp
    maxEdgeErrorPx: 1.0, // boundary deviation
    enforceOcr: true, // 1:1 lettering/typography
  },
} as const;

export type AppConfig = typeof config;

/**
 * Fail fast on startup if the connector secrets required to actually ship a
 * print file are missing. Geometry-only dry runs can skip this.
 */
export function assertRuntimeConfig(): void {
  const missing: string[] = [];
  if (!config.supabase.url) missing.push('SUPABASE_URL');
  if (!config.supabase.serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }
}
