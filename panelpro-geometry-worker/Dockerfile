# ──────────────────────────────────────────────────────────────────────────────
# PanelPro Geometry Worker — production image (sharp-only, no native OpenCV)
#
# sharp ships prebuilt libvips binaries, so there's nothing to compile — this
# builds in seconds and runs anywhere. Deploy to any container host, or use the
# render.yaml blueprint for a no-Docker managed deploy.
# ──────────────────────────────────────────────────────────────────────────────
# Node 22 — has native WebSocket, which @supabase/supabase-js requires (on
# Node 20 it throws "Node.js 20 detected without native WebSocket support").
FROM node:22-bookworm-slim

WORKDIR /app

# Install dependencies (no native build step).
COPY package.json ./
RUN npm install --include=dev --no-audit --no-fund

# Build the TypeScript worker.
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN npm run build

# Shed dev dependencies for a leaner runtime.
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node scripts/healthcheck.js

CMD ["node", "dist/index.js"]
