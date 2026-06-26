/**
 * Storage facade — the rest of the app imports uploads/signing from here.
 *
 * Picks the backend from config: Cloudflare R2 when R2 credentials are set
 * (no 50 MB cap; free), otherwise Supabase Storage. Both backends expose the
 * same three functions, so nothing downstream changes.
 */

import { config } from './config.js';
import * as supabase from './supabase.js';
import * as r2 from './r2.js';

const backend = config.storage.backend === 'r2' ? r2 : supabase;

export const uploadPrintAsset = backend.uploadPrintAsset;
export const uploadPreview = backend.uploadPreview;
export const createSignedUrl = backend.createSignedUrl;

/** Which backend is active — surfaced in the startup log. */
export const activeBackend = config.storage.backend;
