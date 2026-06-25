/**
 * index.ts — Express webhook listener / job dispatcher.
 *
 * Sits downstream of RestylePro. Receives an extraction job (flat master URL +
 * structural manifest), validates it, and runs the deterministic Panel-First
 * pipeline. Jobs are processed asynchronously so the HTTP request returns fast;
 * a QC-gate rejection is logged and surfaced via the job log, never shipped.
 *
 * This service is intentionally standalone — no frontend, no edge runtime
 * coupling. It assumes a memory-unconstrained container.
 */

import path from 'node:path';
import express, { type Request, type Response } from 'express';
import multer from 'multer';
import { config, assertRuntimeConfig } from './config';
import { executeMechanicalExtraction } from './processor';
import { QcGateError } from './qc';
import { resolveDimensions } from './sizing';
import { createJob, getJob, listJobs, updateJob } from './jobs';
import type { ExtractionJob, PanelManifest } from './types';

const app = express();

// Large manifests are fine; on the automated route the raster is fetched by
// URL, not posted.
app.use(express.json({ limit: '8mb' }));

// Manual-upload backup route: proofs are large print rasters, kept in memory
// (this container is memory-unconstrained by design) and handed straight to the
// pipeline as a buffer. 512 MB ceiling guards against accidental huge uploads.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 * 1024, files: 1 },
});

// Operator console (static SPA). Not part of the print pipeline — observability
// only. Served from the repo-root /public dir (one level up from dist/ or src/).
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/healthz', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'panelpro-geometry-worker' });
});

/**
 * Preview the deterministic output dimensions for a panel without running a
 * job. Lets the UI confirm the absolute pixel math before dispatch.
 */
app.post('/preview/dimensions', (req: Request, res: Response) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    res.json(
      resolveDimensions({
        widthInches: Number(b.widthInches),
        heightInches: Number(b.heightInches),
        dpi: b.dpi == null ? undefined : Number(b.dpi),
        bleedInches: b.bleedInches == null ? undefined : Number(b.bleedInches),
      }),
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** Poll a single job's status (used by the operator UI). */
app.get('/jobs/:id', (req: Request, res: Response) => {
  const rec = getJob(req.params.id ?? '');
  if (!rec) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  res.json(rec);
});

/** Recent jobs for the console list. */
app.get('/jobs', (_req: Request, res: Response) => {
  res.json(listJobs());
});

/**
 * Inbound webhook. Authenticates with a shared secret, validates the payload
 * shape, ACKs immediately (202), then dispatches the job off the request path.
 */
app.post('/webhook/extract', (req: Request, res: Response) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  let job: ExtractionJob;
  try {
    job = validateJob(req.body);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  // Accept and process out-of-band so a 30000×9150 warp never blocks the socket.
  createJob(job.jobId);
  res.status(202).json({ accepted: true, jobId: job.jobId });
  void dispatch(job);
});

/**
 * Manual-upload backup route. Operator drops a standalone 2D proof + the sizing
 * metadata; the worker bypasses the RestylePro fetch and runs the identical
 * deterministic pipeline on the uploaded buffer.
 *
 * multipart/form-data:
 *   - `artwork`: the raw proof image (PNG/TIFF/…)
 *   - `payload`: JSON string { jobId, outputPath, manifest } (no masterArtworkUrl)
 */
app.post('/webhook/extract/upload', upload.single('artwork'), (req: Request, res: Response) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (!req.file || !req.file.buffer?.length) {
    res.status(400).json({ error: 'No artwork file uploaded (field "artwork").' });
    return;
  }

  let job: ExtractionJob;
  try {
    const raw = (req.body as Record<string, unknown>)?.payload;
    if (typeof raw !== 'string') throw new Error('Missing "payload" JSON field.');
    const parsed = JSON.parse(raw) as unknown;
    // URL not required here — the master comes from the uploaded buffer.
    job = validateJob(parsed, { requireMasterUrl: false });
    job.masterBytes = req.file.buffer;
    job.source = 'manual-upload';
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  createJob(job.jobId);
  res.status(202).json({ accepted: true, jobId: job.jobId, source: 'manual-upload' });
  void dispatch(job);
});

async function dispatch(job: ExtractionJob): Promise<void> {
  const started = Date.now();
  updateJob(job.jobId, { status: 'processing' });
  try {
    const result = await executeMechanicalExtraction(job);
    updateJob(job.jobId, { status: 'completed', result });
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'extraction.completed',
        jobId: result.jobId,
        panelId: result.panelId,
        dimensions: `${result.dimensions.targetWidthPx}x${result.dimensions.targetHeightPx}`,
        storagePath: result.storagePath,
        inpaintedVoids: result.inpaintedVoids,
        qcMetrics: result.qc.metrics.map((m) => `${m.name}=${m.value.toFixed(4)}`),
        ms: Date.now() - started,
      }),
    );
  } catch (err) {
    if (err instanceof QcGateError) {
      // Strict gate halted the job — do NOT publish a degraded print.
      const failures = err.report.metrics
        .filter((m) => !m.passed)
        .map((m) => ({ name: m.name, value: m.value, threshold: m.threshold }));
      updateJob(err.jobId, { status: 'qc_rejected', failures, error: err.message });
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'extraction.qc_rejected',
          jobId: err.jobId,
          failures,
          ms: Date.now() - started,
        }),
      );
      return;
    }
    updateJob(job.jobId, { status: 'failed', error: (err as Error).message });
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'extraction.failed',
        jobId: job.jobId,
        error: (err as Error).message,
        ms: Date.now() - started,
      }),
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────────

function isAuthorized(req: Request): boolean {
  if (!config.webhookSecret) return true; // open in local/dev when unset
  return req.header('x-panelpro-signature') === config.webhookSecret;
}

interface ValidateOpts {
  /** Whether manifest.masterArtworkUrl must be present (false for uploads). */
  requireMasterUrl: boolean;
}

function validateJob(body: unknown, opts: ValidateOpts = { requireMasterUrl: true }): ExtractionJob {
  if (!body || typeof body !== 'object') throw new Error('Body must be a JSON object.');
  const b = body as Record<string, unknown>;

  if (typeof b.jobId !== 'string' || !b.jobId) throw new Error('jobId is required.');
  if (typeof b.outputPath !== 'string' || !b.outputPath) {
    throw new Error('outputPath is required.');
  }
  const manifest = validateManifest(b.manifest, opts);
  return { jobId: b.jobId, outputPath: b.outputPath, manifest, source: 'restylepro-url' };
}

function validateManifest(raw: unknown, opts: ValidateOpts): PanelManifest {
  if (!raw || typeof raw !== 'object') throw new Error('manifest is required.');
  const m = raw as Record<string, unknown>;

  if (typeof m.panelId !== 'string' || !m.panelId) throw new Error('manifest.panelId is required.');
  if (opts.requireMasterUrl && (typeof m.masterArtworkUrl !== 'string' || !m.masterArtworkUrl)) {
    throw new Error('manifest.masterArtworkUrl is required.');
  }

  const phys = m.physical as Record<string, unknown> | undefined;
  if (!phys || typeof phys.widthInches !== 'number' || typeof phys.heightInches !== 'number') {
    throw new Error('manifest.physical.{widthInches,heightInches} are required numbers.');
  }

  const quad = m.sourceQuad;
  if (!Array.isArray(quad) || quad.length !== 4) {
    throw new Error('manifest.sourceQuad must be exactly 4 points (TL,TR,BR,BL).');
  }
  for (const p of quad) {
    const pt = p as Record<string, unknown>;
    if (typeof pt?.x !== 'number' || typeof pt?.y !== 'number') {
      throw new Error('Each sourceQuad point needs numeric {x,y}.');
    }
  }

  return raw as unknown as PanelManifest;
}

// ────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ────────────────────────────────────────────────────────────────────────────

function main(): void {
  assertRuntimeConfig();
  app.listen(config.port, () => {
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'worker.listening',
        port: config.port,
        dpi: config.geometry.defaultDpi,
        bleedInches: config.geometry.defaultBleedInches,
        inpaint: config.inpaint.provider || 'disabled',
      }),
    );
  });
}

main();
