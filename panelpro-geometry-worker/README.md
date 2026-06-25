# panelpro-geometry-worker

Deterministic **Panel-First** pre-press extraction worker for large-format
print. It sits directly downstream of the RestylePro (Konva.js) design canvas
and runs on an independent, memory-unconstrained container — fully decoupled
from the Vercel/Deno edge environments.

> **Core principle:** the geometry engine mechanically slices, scales, and pads
> artwork layers using absolute math driven by RestylePro metadata. AI is used
> **only** for sub-surface inpainting of physically hidden voids (door handle
> voids, mirror mounts, wheel arches). No model ever chooses canvas dimensions
> or infers panel boundaries from pixels.

## Pipeline (`src/processor.ts → executeMechanicalExtraction`)

| Step | What happens | Tech |
|------|--------------|------|
| **A. Download** | Fetch the raw flat master design canvas. | `axios` |
| **B. Crop & warp** | Map source-canvas quad → exact target rectangle. LANCZOS4 for razor-sharp vector text; `BORDER_REPLICATE` deterministically extends edges into the 5″ bleed. | `opencv4nodejs` (`findHomography` → `warpPerspective`) |
| **C. Compile layout** | Promote into 16-bit working space, aspect-locked lanczos3 resize. | `sharp` / `libvips` |
| **D. Surgical AI repair** | Build a binary mask from occlusion polygons; pass **only** the flat asset + mask to the inpainter at `temperature 0.0`. | `src/inpaint.ts` |
| **E. Export** | Write an **8-bit, uncompressed (level 0), lossless RGBA PNG** and upload. | `sharp` → `@supabase/supabase-js` |

### Color handling
All color-sensitive compositing runs in Sharp's **16-bit-per-channel** space to
avoid gradient banding across print-resolution canvases. The pipeline flattens
to 8-bit exactly once, at the final PNG write — no lossy PNG→JPEG→PNG hops.

## Sizing (`src/sizing.ts`)
Absolute pixel math, never inferred:

```
targetWidthPx  = round((widthInches  + bleed * 2) * dpi)
targetHeightPx = round((heightInches + bleed * 2) * dpi)
```

Baseline constants: **DPI = 150**, **default bleed = 5″**.
Worked example: a `190" × 51"` panel @ 150 DPI with 5″ bleed →
**exactly `30000 × 9150` px**.

## Strict QC gate (`src/qc.ts`)
The exported print file is validated against the original RestylePro source.
**Any single violation halts the job** (`QcGateError`) — a degraded asset is
never uploaded.

| Metric | Reject when | Notes |
|--------|-------------|-------|
| Color ΔE (CIEDE2000) | `> 2.0` | hue drift / ambient dimming |
| SSIM | `< 0.98` | pixel blur / layout warp |
| Edge error | `> 1 px` | boundary deviation |
| OCR text change | any difference | 1:1 lettering/typography (optional `tesseract.js`) |

## Layout
```
panelpro-geometry-worker/
├── src/
│   ├── index.ts        # Express dispatcher: URL webhook + manual-upload route
│   ├── processor.ts    # OpenCV geometry warp & 16-bit Sharp execution
│   ├── qc.ts           # Strict Delta-E & SSIM gate metrics
│   ├── inpaint.ts      # Sub-surface AI repair (occlusion-masked only)
│   ├── sizing.ts       # Absolute dimension math
│   ├── supabase.ts     # Storage connector
│   ├── jobs.ts         # In-memory job status registry
│   ├── config.ts       # Validated runtime config + QC thresholds
│   └── types.ts        # Shared manifest / job contracts
├── public/
│   └── index.html      # Operator console (URL + file-upload UI)
├── scripts/
│   └── healthcheck.js  # Container HEALTHCHECK probe
├── Dockerfile          # Host-agnostic production image (builds OpenCV bindings)
├── .dockerignore
├── package.json
├── tsconfig.json
└── .env.example
```

## Run

```bash
cp .env.example .env      # fill in Supabase + (optional) inpaint provider
npm install               # builds native opencv4nodejs — see note below
npm run build && npm start
# dev: npm run dev
```

### Deploy (Docker, host-agnostic)

```bash
docker build -t panelpro-geometry-worker .
docker run -p 8080:8080 --env-file .env panelpro-geometry-worker
```

The image installs `libopencv-dev` and compiles the native `opencv4nodejs`
bindings during build, so no OpenCV setup is needed on the host. Hand the same
Dockerfile to Render, Railway, Fly.io, ECS, Cloud Run, or your own VM.

### Deploy to a DigitalOcean Droplet (Docker Compose)

```bash
# 1) Docker on the host
curl -fsSL https://get.docker.com | sudo sh

# 2) Add swap — Droplets ship with NONE, and a big job can briefly spike.
sudo fallocate -l 8G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 3) Code + secrets
git clone <your-repo> && cd panelpro-geometry-worker
cp .env.example .env && nano .env        # fill SUPABASE_* and WEBHOOK_SECRET

# 4) Build native bindings + run
docker compose up -d --build
docker compose logs -f
```

#### Sizing — read this before picking a Droplet

A single `30000 × 9150` job is **274.5 MP**. Its native buffers (warped Mat ≈
1.1 GB, the 16-bit RGBA working raster ≈ 2.2 GB, the level-0 output PNG ≈ 1.1 GB,
plus the QC reload) coexist at peak, so **expect ~5–8 GB of RAM per concurrent
job**. These are off-heap native/libvips allocations — a crash shows up as the
host **OOM-killer**, not a V8 heap error, so `--max-old-space-size` won't help.

| Workload | Droplet RAM | Notes |
|----------|-------------|-------|
| One panel at a time | **8 GB** + 8 GB swap | comfortable single-job |
| Concurrent panels | **16 GB+** | size to peak × concurrency |
| 4 GB (e.g. t4g.medium) | ❌ | will OOM on a full panel |

`docker-compose.yml` sets `mem_limit` as a guard (kills a runaway job instead of
the host) — tune it below your Droplet's RAM.

#### Security (public IP)

- **Set `WEBHOOK_SECRET`.** When unset, the webhook accepts anonymous jobs.
- The compose file binds the port to `127.0.0.1` and assumes a **TLS reverse
  proxy** (Caddy/Nginx + Let's Encrypt) in front. A browser on an HTTPS
  dashboard **cannot** call `http://<droplet-ip>:8080` (mixed content) — give the
  worker a domain with HTTPS.

## Submitting jobs

### Automated route (RestylePro URL)

```bash
curl -X POST http://localhost:8080/webhook/extract \
  -H 'content-type: application/json' \
  -H 'x-panelpro-signature: <WEBHOOK_SECRET>' \
  -d '{
    "jobId": "job_123",
    "outputPath": "panels/job_123.png",
    "manifest": {
      "panelId": "drv-side",
      "masterArtworkUrl": "https://.../master.png",
      "physical": { "widthInches": 190, "heightInches": 51, "dpi": 150, "bleedInches": 5 },
      "sourceQuad": [
        {"x":0,"y":0},{"x":4000,"y":0},{"x":4000,"y":1080},{"x":0,"y":1080}
      ],
      "occlusions": [
        {"id":"handle","label":"driver-door-handle","points":[
          {"x":12000,"y":4000},{"x":12600,"y":4000},
          {"x":12600,"y":4400},{"x":12000,"y":4400}]}
      ]
    }
  }'
```

### Manual-upload backup route (standalone 2D proof)

When the RestylePro sync is unavailable — dropped connection, canvas error, or a
designer emails a standalone high-res proof — upload the file directly. You
supply the sizing metadata (or pick a panel template in the UI); the worker
bypasses the URL fetch and runs the **identical** deterministic pipeline on the
uploaded buffer.

```bash
curl -X POST http://localhost:8080/webhook/extract/upload \
  -H 'x-panelpro-signature: <WEBHOOK_SECRET>' \
  -F 'artwork=@/path/to/proof.png' \
  -F 'payload={
        "jobId":"job_manual_1",
        "outputPath":"panels/job_manual_1.png",
        "manifest":{
          "panelId":"drv-side",
          "physical":{"widthInches":190,"heightInches":51,"dpi":150,"bleedInches":5},
          "sourceQuad":[{"x":0,"y":0},{"x":4000,"y":0},{"x":4000,"y":1080},{"x":0,"y":1080}],
          "occlusions":[]
        }
      }'
```

In the operator console, flip the **Artwork source** toggle to *Manual upload*,
drop the proof in, pick a panel template, and run — same `30000 × 9150`
lossless output.

Either route responds `202 Accepted` and processes out-of-band; completion and
QC results are emitted as structured JSON logs and surfaced in the UI.

## Notes on native dependencies
- **`opencv4nodejs`** compiles native OpenCV bindings and needs OpenCV (≥4.x)
  plus a C++ toolchain on the build host. In CI/containers, install OpenCV first
  (e.g. `apt-get install -y libopencv-dev`) or point `OPENCV4NODEJS_*` env vars
  at a prebuilt OpenCV.
- **`sharp`** ships prebuilt libvips binaries for common platforms.
- **`tesseract.js`** is an optional dependency; if absent, the OCR gate is
  skipped (logged) rather than failing the build.
