/**
 * Infrastructure connector — Supabase Storage upload.
 *
 * The worker writes the raw, lossless print chunk straight into the configured
 * bucket. No transformation happens here; bytes in === bytes stored.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!client) {
    client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run an operation with 4-tier exponential backoff (waits 1s, 2s, 4s between
 * tries) so a transient network blip doesn't fail an otherwise-good job.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(1000 * 2 ** i); // 1s, 2s, 4s
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${(lastErr as Error)?.message ?? lastErr}`);
}

/**
 * Upload a finished print asset. The buffer is uploaded verbatim with
 * `upsert: true` so re-runs of a job overwrite the prior artifact.
 *
 * @returns the object path that was written.
 */
export async function uploadPrintAsset(objectPath: string, png: Buffer): Promise<string> {
  await withRetry(`upload ${objectPath}`, async () => {
    const { error } = await getClient()
      .storage.from(config.supabase.bucket)
      .upload(objectPath, png, {
        contentType: 'image/png',
        upsert: true,
        // Lossless asset: never let a CDN re-encode it.
        cacheControl: 'no-transform, max-age=31536000',
      });
    if (error) throw new Error(error.message);
  });
  return objectPath;
}

/** Upload a small preview thumbnail (JPEG) for the operator console. */
export async function uploadPreview(objectPath: string, jpeg: Buffer): Promise<string> {
  await withRetry(`preview upload ${objectPath}`, async () => {
    const { error } = await getClient()
      .storage.from(config.supabase.bucket)
      .upload(objectPath, jpeg, { contentType: 'image/jpeg', upsert: true });
    if (error) throw new Error(error.message);
  });
  return objectPath;
}

/**
 * Mint a short-lived signed URL for an object. Generated on demand per click so
 * links never go stale and work for private buckets.
 */
export async function createSignedUrl(objectPath: string, expiresInSec = 3600): Promise<string> {
  return withRetry(`sign ${objectPath}`, async () => {
    const { data, error } = await getClient()
      .storage.from(config.supabase.bucket)
      .createSignedUrl(objectPath, expiresInSec);
    if (error || !data?.signedUrl) {
      throw new Error(error?.message ?? 'no url');
    }
    return data.signedUrl;
  });
}
