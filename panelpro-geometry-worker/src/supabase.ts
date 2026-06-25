/**
 * Infrastructure connector — Supabase Storage upload.
 *
 * The worker writes the raw, lossless print chunk straight into the configured
 * bucket. No transformation happens here; bytes in === bytes stored.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from './config';

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!client) {
    client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/**
 * Upload a finished print asset. The buffer is uploaded verbatim with
 * `upsert: true` so re-runs of a job overwrite the prior artifact.
 *
 * @returns the object path that was written.
 */
export async function uploadPrintAsset(objectPath: string, png: Buffer): Promise<string> {
  const { error } = await getClient()
    .storage.from(config.supabase.bucket)
    .upload(objectPath, png, {
      contentType: 'image/png',
      upsert: true,
      // Lossless asset: never let a CDN re-encode it.
      cacheControl: 'no-transform, max-age=31536000',
    });

  if (error) {
    throw new Error(`Supabase upload failed for ${objectPath}: ${error.message}`);
  }
  return objectPath;
}
