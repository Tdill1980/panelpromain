#!/usr/bin/env bash
#
# deploy.sh — one-command deploy of panelpro-geometry-worker to a DigitalOcean Droplet.
#
# Run from your laptop in a bash shell:
#   • macOS / Linux: any terminal
#   • Windows: Git Bash or WSL (PowerShell can't run .sh directly)
#
#   ./deploy.sh
#
# Over SSH it will:
#   1. ensure git + docker are installed on the Droplet
#   2. clone/update the repo (branch: main)
#   3. configure an 8 GB swap safety net (idempotent)
#   4. copy your LOCAL secrets file into place as .env (over encrypted SSH)
#   5. docker compose up -d --build   (boot the worker container)
#   6. health-check the running worker
#
# SECRETS ARE NEVER HARD-CODED HERE. Put them in a local, git-ignored file
# (default ./deploy.env — start from deploy.env.example) which is scp'd to the
# Droplet. That keeps your Supabase service_role key out of the git repo.

set -euo pipefail

# ── Config (override any of these via environment variables) ──────────────────
DROPLET_IP="${DROPLET_IP:-143.110.237.145}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-}"                       # optional: path to a private key
REPO_URL="${REPO_URL:-https://github.com/Tdill1980/panelpromain.git}"
BRANCH="${BRANCH:-main}"
REMOTE_BASE="${REMOTE_BASE:-/root/panelpromain}"
WORKER_SUBDIR="panelpro-geometry-worker"
LOCAL_ENV_FILE="${LOCAL_ENV_FILE:-./deploy.env}"
SWAP_SIZE="${SWAP_SIZE:-8G}"
# Which compose services to boot. Defaults to just the worker (no public domain
# needed). Set COMPOSE_SERVICES="" to also bring up the Caddy TLS proxy once you
# have WORKER_DOMAIN set in deploy.env and DNS pointed at the Droplet.
COMPOSE_SERVICES="${COMPOSE_SERVICES:-worker}"

REMOTE_WORKER_DIR="${REMOTE_BASE}/${WORKER_SUBDIR}"
SSH_TARGET="${SSH_USER}@${DROPLET_IP}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
[ -n "$SSH_KEY" ] && SSH_OPTS+=(-i "$SSH_KEY")

log()  { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# ── Preflight ─────────────────────────────────────────────────────────────────
command -v ssh >/dev/null || die "ssh not found. Use macOS/Linux, WSL, or Git Bash."
command -v scp >/dev/null || die "scp not found."
[ -f "$LOCAL_ENV_FILE" ] || die "Secrets file '$LOCAL_ENV_FILE' not found.
   Create it: cp deploy.env.example deploy.env  (then fill in your real keys)."

log "Deploying branch '${BRANCH}' to ${SSH_TARGET}:${REMOTE_WORKER_DIR}"

# ── 1–3. Remote bootstrap: tools, repo checkout, swap ─────────────────────────
# Args are passed positionally so the heredoc stays single-quoted (no local
# expansion of remote variables).
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" 'bash -s' \
  "$REPO_URL" "$BRANCH" "$REMOTE_BASE" "$SWAP_SIZE" <<'REMOTE'
set -euo pipefail
REPO_URL="$1"; BRANCH="$2"; REMOTE_BASE="$3"; SWAP_SIZE="$4"
step() { printf '  • %s\n' "$*"; }

# Tools
if ! command -v git >/dev/null;    then step "installing git";    apt-get update -y >/dev/null && apt-get install -y git >/dev/null; fi
if ! command -v docker >/dev/null; then step "installing docker"; curl -fsSL https://get.docker.com | sh >/dev/null; fi

# Repo: clone fresh, or hard-sync to the target branch
if [ -d "$REMOTE_BASE/.git" ]; then
  step "updating repo -> origin/$BRANCH"
  git -C "$REMOTE_BASE" fetch --quiet origin "$BRANCH"
  git -C "$REMOTE_BASE" checkout --quiet "$BRANCH"
  git -C "$REMOTE_BASE" reset --hard --quiet "origin/$BRANCH"
else
  step "cloning repo"
  rm -rf "$REMOTE_BASE"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$REMOTE_BASE"
fi

# Swap safety net (idempotent)
if swapon --show=NAME --noheadings 2>/dev/null | grep -q '/swapfile'; then
  step "swap already active"
else
  step "creating ${SWAP_SIZE} swap"
  fallocate -l "$SWAP_SIZE" /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=8192 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
echo "  • bootstrap complete"
REMOTE
ok "Droplet bootstrapped (tools, repo, swap)"

# ── 4. Ship secrets ───────────────────────────────────────────────────────────
log "Uploading secrets -> ${REMOTE_WORKER_DIR}/.env"
scp "${SSH_OPTS[@]}" "$LOCAL_ENV_FILE" "${SSH_TARGET}:${REMOTE_WORKER_DIR}/.env"
ok "Secrets in place"

# ── 5. Build & boot ───────────────────────────────────────────────────────────
log "Building image & starting container(s): ${COMPOSE_SERVICES:-all}"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
  "cd '${REMOTE_WORKER_DIR}' && docker compose up -d --build ${COMPOSE_SERVICES}"

# ── 6. Health check ───────────────────────────────────────────────────────────
log "Health check (http://127.0.0.1:8080/healthz on the Droplet)"
healthy=""
for attempt in 1 2 3 4 5 6; do
  if ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "curl -fsS http://127.0.0.1:8080/healthz" 2>/dev/null; then
    healthy=1; break
  fi
  printf '   …not up yet (attempt %s/6), waiting 5s\n' "$attempt"; sleep 5
done

echo
if [ -n "$healthy" ]; then
  ok "Worker is LIVE on the Droplet."
  echo "   Console (temporary HTTP): http://${DROPLET_IP}:8080"
else
  die "Worker did not report healthy. Inspect logs:
   ssh ${SSH_TARGET} \"cd ${REMOTE_WORKER_DIR} && docker compose logs worker --tail 40\""
fi
