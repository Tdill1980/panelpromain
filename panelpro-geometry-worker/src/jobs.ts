/**
 * jobs.ts — in-memory job registry.
 *
 * Lightweight status tracking so the operator UI can poll a job after the
 * webhook ACKs. This is intentionally process-local and ephemeral; for durable
 * tracking, back it with Supabase/Redis. It is NOT part of the print pipeline —
 * purely observability for the operator console.
 */

import type { DimensionSource, ExtractionResult, PanelManifest } from './types.js';

export type JobStatus = 'queued' | 'processing' | 'completed' | 'qc_rejected' | 'failed';

/** Sizing surfaced on the card as soon as the job is accepted. */
export interface JobMeta {
  targetWidthPx: number;
  targetHeightPx: number;
  dimensionSource: DimensionSource;
}

/** Re-runnable job inputs (no raw bytes) so a job can be Force Re-Extracted. */
export interface JobInputs {
  manifest: PanelManifest;
  outputPath: string;
  source?: 'restylepro-url' | 'manual-upload';
}

export interface JobRecord {
  jobId: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  /** Resolved sizing + provenance, populated at creation. */
  meta?: JobMeta;
  /** Re-runnable inputs for Force Re-Extract (URL jobs only; no raw bytes). */
  inputs?: JobInputs;
  /** Current pipeline stage, surfaced live in the console progress tracker. */
  stage?: string;
  result?: ExtractionResult;
  /** Failure / QC detail for the UI. */
  error?: string;
  failures?: { name: string; value: number; threshold: number }[];
}

const REGISTRY = new Map<string, JobRecord>();
/** Cap the registry so a long-running worker never leaks memory. */
const MAX_RECORDS = 500;

function now(): number {
  return Date.now();
}

export function createJob(jobId: string, meta?: JobMeta, inputs?: JobInputs): JobRecord {
  const rec: JobRecord = { jobId, status: 'queued', createdAt: now(), updatedAt: now(), meta, inputs };
  REGISTRY.set(jobId, rec);
  evictIfNeeded();
  return rec;
}

export function updateJob(jobId: string, patch: Partial<Omit<JobRecord, 'jobId'>>): void {
  const rec = REGISTRY.get(jobId);
  if (!rec) return;
  Object.assign(rec, patch, { updatedAt: now() });
}

export function getJob(jobId: string): JobRecord | undefined {
  return REGISTRY.get(jobId);
}

export function listJobs(limit = 50): JobRecord[] {
  return [...REGISTRY.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

function evictIfNeeded(): void {
  if (REGISTRY.size <= MAX_RECORDS) return;
  const oldest = [...REGISTRY.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const rec of oldest) {
    if (REGISTRY.size <= MAX_RECORDS) break;
    REGISTRY.delete(rec.jobId);
  }
}
