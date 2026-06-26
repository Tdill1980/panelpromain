/**
 * Cloudflare R2 storage backend (S3-compatible).
 *
 * Same interface as supabase.ts (uploadPrintAsset / uploadPreview /
 * createSignedUrl) so the storage layer is interchangeable. R2 has no 50 MB
 * free-plan upload cap, so full-resolution print files upload for free.
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config.js';

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: config.storage.r2.endpoint,
      credentials: {
        accessKeyId: config.storage.r2.accessKeyId,
        secretAccessKey: config.storage.r2.secretAccessKey,
      },
    });
  }
  return client;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(1000 * 2 ** i);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${(lastErr as Error)?.message ?? lastErr}`);
}

async function put(objectPath: string, body: Buffer, contentType: string): Promise<string> {
  await withRetry(`R2 upload ${objectPath}`, () =>
    getClient().send(
      new PutObjectCommand({
        Bucket: config.storage.r2.bucket,
        Key: objectPath,
        Body: body,
        ContentType: contentType,
      }),
    ),
  );
  return objectPath;
}

export async function uploadPrintAsset(objectPath: string, png: Buffer): Promise<string> {
  return put(objectPath, png, 'image/png');
}

export async function uploadPreview(objectPath: string, jpeg: Buffer): Promise<string> {
  return put(objectPath, jpeg, 'image/jpeg');
}

export async function createSignedUrl(objectPath: string, expiresInSec = 3600): Promise<string> {
  return withRetry(`R2 sign ${objectPath}`, () =>
    getSignedUrl(
      getClient(),
      new GetObjectCommand({ Bucket: config.storage.r2.bucket, Key: objectPath }),
      { expiresIn: expiresInSec },
    ),
  );
}
