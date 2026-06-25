# panelpro-geometry-worker

Deterministic flat-sheet pre-press extraction worker for large-format print. It
sits downstream of RestylePro / DesignProAI and turns a **multi-view master
proof** (all panels laid out on one flat PNG) into print-ready panel files at
exact size — **sharp/libvips only, no native OpenCV.**

> **Principle:** crop a panel rectangle from the master sheet, size it to exact
> print pixels with absolute math, mirror-extend the bleed, export lossless.
> No perspective guessing, no model choosing dimensions.

## Pipeline (`src/processor.ts → executeMechanicalExtraction`)

| Step | What happens | Tech |
|------|--------------|------|
| **A. Acquire** | Master proof from a URL (`axios`) or an uploaded buffer (manual route). | `axios` |
| **B. Crop** | Extract the exact panel rectangle (`cropBox`) from the sheet. | `sharp.extract` |
| **C. Size** | Resize the crop to exact live pixels in 16-bit space (lanczos3). | `sharp` / `libvips` |
| **D. Bleed** | Mirror-extend the perimeter by the bleed (5″ default). | `sharp.extend extendWith:'mirror'` |
| **E. Export** | **8-bit, level-0, lossless RGBA PNG** → Supabase; + JPEG preview thumbnail. | `sharp` → `@supabase/supabase-js` |

Resampling runs in libvips' 16-bit space (no gradient banding); the final write
flattens to 8-bit exactly once. libvips streams scanlines, so memory stays
bounded even at 274 MP.

## Sizing (`src/sizing.ts`)
```
targetWidthPx  = round((widthInches  + bleed * 2) * dpi)
targetHeightPx = round((heightInches + bleed * 2) * dpi)
```
Baseline: **DPI 150**, **bleed 5″**. A `190" × 51"` panel → exactly **30000 × 9150 px** (verified).

## Strict QC gate (`src/qc.ts`)
The produced panel (minus its bleed border) is validated against the same crop
of the master sheet. **Any single violation halts the job** — no degraded asset
is uploaded.

| Metric | Reject when |
|--------|-------------|
| Color ΔE (CIEDE2000) | `> 2.0` |
| SSIM | `< 0.98` |
| Edge error | `> 1 px` |
| OCR text change | any difference (optional `tesseract.js`) |

## Two workflows

**1. Automated (RestylePro).** The dashboard's "Build Files" posts a job to
`POST /webhook/extract` with the master URL + each panel's `cropBox`; the worker
renders and drops files into the bucket, hands-off.

**2. Manual operator console (`public/index.html`).** Toggle to *Manual upload*,
drop a standalone multi-view proof, pick a panel preset, enter/confirm the crop
box, Run — and get a Download link on the spot. Job cards show resolved W×H and a
verification badge (green ✓ for database/csv sizing, amber ⚠️ for manual/fallback).

## Layout
```
panelpro-geometry-worker/
├── src/
│   ├── index.ts        # Express dispatcher: URL webhook + manual-upload + download/preview
│   ├── processor.ts    # sharp crop → size → mirror bleed → 8-bit PNG
│   ├── qc.ts           # Strict ΔE / SSIM / edge / OCR gate
│   ├── sizing.ts       # Absolute dimension math
│   ├── supabase.ts     # Storage upload + signed URLs
│   ├── jobs.ts         # In-memory job status registry
│   ├── config.ts       # Validated runtime config + QC thresholds
│   └── types.ts        # Manifest / job contracts
├── public/index.html   # Operator console
├── scripts/healthcheck.js
├── render.yaml         # Managed (Render) deploy blueprint — recommended
├── Dockerfile          # Container image (sharp-only, builds in seconds)
├── docker-compose.yml  # Self-host (worker + Caddy TLS) option
├── Caddyfile
├── package.json · tsconfig.json · .env.example
```

## Deploy

### Managed — Render (recommended, no terminal)
Push to GitHub, then on render.com: **New → Blueprint → this repo**. Render reads
`render.yaml`, prompts for your secrets (`SUPABASE_*`, `WEBHOOK_SECRET`), and
gives you an auto-HTTPS URL. Pushes to `main` auto-redeploy. No Docker, no SSH.

### Self-host — Docker Compose
```bash
cp .env.example .env   # fill SUPABASE_*, WEBHOOK_SECRET, WORKER_DOMAIN
docker compose up -d --build
```
Builds in seconds now (no OpenCV). Give the host generous RAM — a single
`30000 × 9150` job holds a ~1.1 GB buffer; **8 GB+** recommended.

## Submitting jobs

### Automated route (master URL)
```bash
curl -X POST http://localhost:8080/webhook/extract \
  -H 'content-type: application/json' \
  -H 'x-panelpro-signature: <WEBHOOK_SECRET>' \
  -d '{
    "jobId":"job_1",
    "outputPath":"panels/job_1.png",
    "manifest":{
      "panelId":"drv-side",
      "masterArtworkUrl":"https://.../master-proof.png",
      "physical":{"widthInches":133.9,"heightInches":56,"dpi":150,"bleedInches":5},
      "cropBox":{"x":100,"y":150,"width":4000,"height":1672},
      "dimensionSource":"database"
    }
  }'
```

### Manual-upload route (standalone proof)
```bash
curl -X POST http://localhost:8080/webhook/extract/upload \
  -H 'x-panelpro-signature: <WEBHOOK_SECRET>' \
  -F 'artwork=@/path/to/proof.png' \
  -F 'payload={"jobId":"job_m1","outputPath":"panels/job_m1.png","manifest":{"panelId":"drv-side","physical":{"widthInches":133.9,"heightInches":56,"dpi":150,"bleedInches":5},"cropBox":{"x":100,"y":150,"width":4000,"height":1672}}}'
```

Both respond `202 Accepted` and process out-of-band; completion + QC results are
logged as JSON and surfaced in the console with a Download link.
