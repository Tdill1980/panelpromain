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

import express, { type Request, type Response } from 'express';
import { config, assertRuntimeConfig } from './config';
import { executeMechanicalExtraction } from './processor';
import { QcGateError } from './qc';
import type { ExtractionJob, PanelManifest } from './types';

const app = express();

// Large manifests are fine; the raster itself is fetched by URL, not posted.
app.use(express.json({ limit: '8mb' }));

app.get('/healthz', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'panelpro-geometry-worker' });
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
  res.status(202).json({ accepted: true, jobId: job.jobId });
  void dispatch(job);
});

async function dispatch(job: ExtractionJob): Promise<void> {
  const started = Date.now();
  try {
    const result = await executeMechanicalExtraction(job);
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
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'extraction.qc_rejected',
          jobId: err.jobId,
          failures: err.report.metrics.filter((m) => !m.passed),
          ms: Date.now() - started,
        }),
      );
      return;
    }
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

function validateJob(body: unknown): ExtractionJob {
  if (!body || typeof body !== 'object') throw new Error('Body must be a JSON object.');
  const b = body as Record<string, unknown>;

  if (typeof b.jobId !== 'string' || !b.jobId) throw new Error('jobId is required.');
  if (typeof b.outputPath !== 'string' || !b.outputPath) {
    throw new Error('outputPath is required.');
  }
  const manifest = validateManifest(b.manifest);
  return { jobId: b.jobId, outputPath: b.outputPath, manifest };
}

function validateManifest(raw: unknown): PanelManifest {
  if (!raw || typeof raw !== 'object') throw new Error('manifest is required.');
  const m = raw as Record<string, unknown>;

  if (typeof m.panelId !== 'string' || !m.panelId) throw new Error('manifest.panelId is required.');
  if (typeof m.masterArtworkUrl !== 'string' || !m.masterArtworkUrl) {
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
