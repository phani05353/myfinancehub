#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# MyFinanceHub — homelab deploy script
# Run from: /home/phanikumar/finance-hub/
#
# Layout expected:
#   finance-hub/
#   ├── deploy.sh             ← this script
#   ├── myfinancehub/         ← git repo (auto-cloned if missing)
#   ├── container-data/       ← finance SQLite DB     (preserved across deploys)
#   └── container-receipts/   ← receipt images / PDFs (preserved across deploys)
#
# Temporal is now SHARED: a single server owned by the home-lab-utils stack
# (homelab.sh → container "homelab-temporal" on network "homelab-net"). This
# script no longer runs its own Temporal — it connects the finance app to that
# shared server. Start the home-lab-utils stack first:  ./homelab.sh up
# The old container-temporal/ dir is left untouched on disk; it is simply unused.
#
# Brings up one container on the shared docker network:
#   • home-finance — the app + Temporal worker (in-process) on :3090
# ─────────────────────────────────────────────────────────────────────────────
set -e

REPO_URL="https://github.com/phani05353/myfinancehub"
REPO_DIR="myfinancehub"
IMAGE_NAME="home-finance"
APP_CONTAINER="home-finance"
# Shared Temporal — owned by the home-lab-utils stack (homelab.sh). Not managed
# here; we only connect the app to it over the shared network below.
TEMPORAL_CONTAINER="homelab-temporal"
NETWORK_NAME="homelab-net"   # shared docker network (created by homelab.sh; we ensure it exists)
APP_PORT=3090            # host → 3000 in container
TEMPORAL_UI_PORT=8234    # home-lab-utils' Temporal Web UI — for the summary message only
BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   MyFinanceHub — Deploy             ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── 1. Pull latest code ───────────────────────────────────────────────────────
echo "▶ Step 1/6 — Updating source code..."
if [ -d "$BASE_DIR/$REPO_DIR/.git" ]; then
  cd "$BASE_DIR/$REPO_DIR"
  git pull
else
  echo "  Repo not found — cloning..."
  cd "$BASE_DIR"
  git clone "$REPO_URL" "$REPO_DIR"
fi
echo "  ✓ Source up to date"

# ── 2. Build finance image ────────────────────────────────────────────────────
echo ""
echo "▶ Step 2/6 — Building Docker image..."
cd "$BASE_DIR/$REPO_DIR"
docker build -t "$IMAGE_NAME" .
echo "  ✓ Image built"

# ── 3. Ensure private network exists ──────────────────────────────────────────
echo ""
echo "▶ Step 3/6 — Ensuring docker network..."
if ! docker network ls --format '{{.Name}}' | grep -qx "$NETWORK_NAME"; then
  docker network create "$NETWORK_NAME" >/dev/null
  echo "  ✓ Network '$NETWORK_NAME' created"
else
  echo "  ✓ Network '$NETWORK_NAME' already exists"
fi

# ── 4. Check the shared Temporal server ───────────────────────────────────────
# Temporal is owned by the home-lab-utils stack (homelab.sh), NOT this script. We
# only verify it's reachable on the shared network. The finance worker retries its
# own connection, so a not-yet-ready Temporal is a warning here, never a hard fail.
# The old container-temporal/ bind dir is intentionally left untouched on disk.
echo ""
echo "▶ Step 4/6 — Checking shared Temporal ($TEMPORAL_CONTAINER)..."
if ! docker ps --format '{{.Names}}' | grep -qx "$TEMPORAL_CONTAINER"; then
  echo "  ⚠ Container '$TEMPORAL_CONTAINER' is not running."
  echo "    Start the home-lab-utils stack first:  (in home-lab-utils)  ./homelab.sh up"
  echo "    Continuing anyway — the finance worker will retry until Temporal is up."
else
  READY=0
  for i in $(seq 1 20); do
    if docker exec "$TEMPORAL_CONTAINER" temporal workflow list --namespace default --limit 1 >/dev/null 2>&1; then
      READY=1
      break
    fi
    sleep 3
  done
  if [ "$READY" = "1" ]; then
    echo "  ✓ Shared Temporal is up and reachable"
  else
    echo "  ⚠ Temporal is running but didn't pass readiness in 60s — continuing (worker retries)"
  fi
fi

# ── 5. Replace app container ──────────────────────────────────────────────────
echo ""
echo "▶ Step 5/6 — Replacing app container..."
docker stop "$APP_CONTAINER" 2>/dev/null && echo "  Stopped old app container" || echo "  No running app container found"
docker rm   "$APP_CONTAINER" 2>/dev/null || true

# Host-only secrets (Resend API key, report recipient, AND the Authentik OIDC
# settings). This file lives OUTSIDE the git repo and is never committed — it
# only ever exists on this homelab box. Passed straight into the container env
# via --env-file. If it's missing, the monthly-report email no-ops; and without
# the OIDC_* vars below, login (Authentik SSO) will fail on first redirect.
#
# Required for login — add these to finance.env (use the homelab HOST IP, not a
# container DNS name, so the issuer matches what the browser hits):
#   OIDC_ISSUER=http://<homelab-ip>:9000/application/o/myfinancehub/
#   OIDC_CLIENT_ID=<from Authentik provider>
#   OIDC_CLIENT_SECRET=<from Authentik provider>
#   OIDC_REDIRECT_URI=http://<homelab-ip>:3090/auth/callback
#   # optional: OIDC_POST_LOGOUT_REDIRECT_URI=http://<homelab-ip>:3090/auth/login
ENV_FILE="$BASE_DIR/finance.env"
ENV_FILE_ARG=""
if [ -f "$ENV_FILE" ]; then
  ENV_FILE_ARG="--env-file $ENV_FILE"
  echo "  ✓ Injecting host secrets from $ENV_FILE"
else
  echo "  ⚠ No secrets file at $ENV_FILE — monthly email report will be skipped"
  echo "    Create it (chmod 600) with: RESEND_API_KEY=re_xxx"
fi

# Publish on loopback (tailscale serve proxies to http://localhost:3090) + the LAN
# IP only — NOT 0.0.0.0. `tailscale serve --https=3090` already owns :3090 on the
# tailnet interface, so a 0.0.0.0:3090 bind collides ("address already in use",
# exit 125) and the container never starts → serve returns 502. Same fix as Immich :8050.
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
PUBLISH="-p 127.0.0.1:${APP_PORT}:3000"
[ -n "$LAN_IP" ] && PUBLISH="$PUBLISH -p ${LAN_IP}:${APP_PORT}:3000"

docker run -d \
  --name "$APP_CONTAINER" \
  --network "$NETWORK_NAME" \
  --restart unless-stopped \
  $PUBLISH \
  -v "$BASE_DIR/container-data:/app/data" \
  -v "$BASE_DIR/container-receipts:/app/uploads/receipts" \
  $ENV_FILE_ARG \
  -e TEMPORAL_ADDRESS="${TEMPORAL_CONTAINER}:7233" \
  -e TEMPORAL_NAMESPACE=default \
  "$IMAGE_NAME" >/dev/null
echo "  ✓ App container started"

# ── 6. Final summary ──────────────────────────────────────────────────────────
echo ""
echo "▶ Step 6/6 — Verifying..."
sleep 2
docker ps --filter "name=$APP_CONTAINER" --filter "name=$TEMPORAL_CONTAINER" \
  --format "  {{.Names}}\t{{.Status}}"

HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$HOST_IP" ] && HOST_IP="localhost"

echo ""
echo "══════════════════════════════════════════════════════════"
echo "  ✅ Deploy complete!"
echo ""
echo "  🌐 App      → http://${HOST_IP}:${APP_PORT}"
echo "  📊 Temporal → http://${HOST_IP}:${TEMPORAL_UI_PORT}  (shared — owned by home-lab-utils)"
echo "                finance-tq schedules now live on the same server as the homelab ones"
echo "══════════════════════════════════════════════════════════"
echo ""
