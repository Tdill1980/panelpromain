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
│   ├── index.ts        # Express webhook listener / job dispatcher
│   ├── processor.ts    # OpenCV geometry warp & 16-bit Sharp execution
│   ├── qc.ts           # Strict Delta-E & SSIM gate metrics
│   ├── inpaint.ts      # Sub-surface AI repair (occlusion-masked only)
│   ├── sizing.ts       # Absolute dimension math
│   ├── supabase.ts     # Storage connector
│   ├── config.ts       # Validated runtime config + QC thresholds
│   └── types.ts        # Shared manifest / job contracts
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

POST a job:

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

The worker responds `202 Accepted` and processes out-of-band; completion and QC
results are emitted as structured JSON logs.

## Notes on native dependencies
- **`opencv4nodejs`** compiles native OpenCV bindings and needs OpenCV (≥4.x)
  plus a C++ toolchain on the build host. In CI/containers, install OpenCV first
  (e.g. `apt-get install -y libopencv-dev`) or point `OPENCV4NODEJS_*` env vars
  at a prebuilt OpenCV.
- **`sharp`** ships prebuilt libvips binaries for common platforms.
- **`tesseract.js`** is an optional dependency; if absent, the OCR gate is
  skipped (logged) rather than failing the build.
