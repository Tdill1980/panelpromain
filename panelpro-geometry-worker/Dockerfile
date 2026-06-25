# ──────────────────────────────────────────────────────────────────────────────
# PanelPro Geometry Worker — production image
#
# Host-agnostic. Builds the native opencv4nodejs bindings against system OpenCV
# (no slow from-source OpenCV autobuild) and ships a long-running Node worker.
# Deploy to Render / Railway / Fly / ECS / Cloud Run / a plain VM — anything that
# runs a container with generous memory (these jobs hold 30000×9150 rasters).
# ──────────────────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim

# Link opencv4nodejs against the distro's prebuilt OpenCV instead of compiling
# the whole library from source on every build.
#
# Debian/Ubuntu install OpenCV under multiarch paths, NOT the /usr/local
# defaults the addon assumes — so point it explicitly or the native build fails
# with "no OpenCV libraries found in lib dir: /usr/local/lib". (amd64 paths.)
ENV OPENCV4NODEJS_DISABLE_AUTOBUILD=1 \
    OPENCV_INCLUDE_DIR=/usr/include/opencv4 \
    OPENCV_LIB_DIR=/usr/lib/x86_64-linux-gnu \
    OPENCV_BIN_DIR=/usr/bin

# Native toolchain + OpenCV dev headers/libs (also satisfies the runtime .so's),
# plus libvips for sharp. Cleaned up in the same layer to keep the image lean.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      cmake \
      pkg-config \
      python3 \
      libopencv-dev \
      libvips42 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) Install dependencies — this compiles the native opencv4nodejs addon.
#    Copied separately so dependency layers cache across source-only changes.
COPY package.json ./
RUN npm install --include=dev --no-audit --no-fund

# 2) Build the TypeScript worker.
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN npm run build

# 3) Shed dev dependencies for a smaller runtime footprint (keeps the compiled
#    native addon intact).
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Container-level liveness — hits the worker's /healthz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node scripts/healthcheck.js

CMD ["node", "dist/index.js"]
