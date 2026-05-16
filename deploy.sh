#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# MyFinanceHub — homelab deploy script
# Run from: /home/phanikumar/finance-hub/
#
# Layout expected:
#   finance-hub/
#   ├── deploy.sh             ← this script
#   ├── myfinancehub/         ← git repo (auto-cloned if missing)
#   ├── container-data/       ← SQLite DB        (never touched)
#   └── container-receipts/   ← receipts         (never touched)
#
# Brings up two containers connected on a private docker network:
#   • home-finance-temporal — Temporal workflow engine + Web UI on :8090
#   • home-finance          — the app  + worker (in-process) on :3090
# ─────────────────────────────────────────────────────────────────────────────
set -e

REPO_URL="https://github.com/phani05353/myfinancehub"
REPO_DIR="myfinancehub"
IMAGE_NAME="home-finance"
APP_CONTAINER="home-finance"
TEMPORAL_CONTAINER="home-finance-temporal"
TEMPORAL_IMAGE="temporalio/temporal:latest"
NETWORK_NAME="home-finance-net"
APP_PORT=3090            # host → 3000 in container
TEMPORAL_UI_PORT=8233    # host → 8233 in container (change if already taken)
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
sudo docker build -t "$IMAGE_NAME" .
echo "  ✓ Image built"

# ── 3. Ensure private network exists ──────────────────────────────────────────
echo ""
echo "▶ Step 3/6 — Ensuring docker network..."
if ! sudo docker network ls --format '{{.Name}}' | grep -qx "$NETWORK_NAME"; then
  sudo docker network create "$NETWORK_NAME" >/dev/null
  echo "  ✓ Network '$NETWORK_NAME' created"
else
  echo "  ✓ Network '$NETWORK_NAME' already exists"
fi

# ── 4. Start Temporal server ──────────────────────────────────────────────────
echo ""
echo "▶ Step 4/6 — Starting Temporal..."
sudo docker stop "$TEMPORAL_CONTAINER" 2>/dev/null && echo "  Stopped old Temporal container" || true
sudo docker rm   "$TEMPORAL_CONTAINER" 2>/dev/null || true

# Precheck: warn if host port is already bound by something else
if command -v ss >/dev/null 2>&1; then
  if ss -tln 2>/dev/null | grep -q ":${TEMPORAL_UI_PORT} "; then
    echo "  ⚠ Port ${TEMPORAL_UI_PORT} is already in use on the host."
    echo "    Edit TEMPORAL_UI_PORT at the top of this script and re-run."
    echo "    Currently bound by:"
    sudo ss -tlnp 2>/dev/null | grep ":${TEMPORAL_UI_PORT} " || true
    exit 1
  fi
fi

# In-memory state — workflow history is wiped on container restart, but our
# worker re-registers all schedules idempotently on every boot, so notifications
# resume automatically. Avoids the SQLite permission/path issues entirely.
sudo docker run -d \
  --name "$TEMPORAL_CONTAINER" \
  --network "$NETWORK_NAME" \
  --restart unless-stopped \
  -p "${TEMPORAL_UI_PORT}:8233" \
  "$TEMPORAL_IMAGE" \
  server start-dev \
    --ip 0.0.0.0 \
    --ui-ip 0.0.0.0 \
    --log-level warn >/dev/null

echo "  Waiting for Temporal to be ready..."
READY=0
for i in $(seq 1 30); do
  if sudo docker exec "$TEMPORAL_CONTAINER" temporal workflow list --namespace default --limit 1 >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 3
done
if [ "$READY" = "1" ]; then
  echo "  ✓ Temporal is up"
else
  echo "  ⚠ Temporal didn't pass readiness check after 90s — the app will still start"
  echo "    Notifications will retry on next container restart."
fi

# ── 5. Replace app container ──────────────────────────────────────────────────
echo ""
echo "▶ Step 5/6 — Replacing app container..."
sudo docker stop "$APP_CONTAINER" 2>/dev/null && echo "  Stopped old app container" || echo "  No running app container found"
sudo docker rm   "$APP_CONTAINER" 2>/dev/null || true

sudo docker run -d \
  --name "$APP_CONTAINER" \
  --network "$NETWORK_NAME" \
  --restart unless-stopped \
  -p "${APP_PORT}:3000" \
  -v "$BASE_DIR/container-data:/app/data" \
  -v "$BASE_DIR/container-receipts:/app/uploads/receipts" \
  -e TEMPORAL_ADDRESS="${TEMPORAL_CONTAINER}:7233" \
  -e TEMPORAL_NAMESPACE=default \
  "$IMAGE_NAME" >/dev/null
echo "  ✓ App container started"

# ── 6. Final summary ──────────────────────────────────────────────────────────
echo ""
echo "▶ Step 6/6 — Verifying..."
sleep 2
sudo docker ps --filter "name=$APP_CONTAINER" --filter "name=$TEMPORAL_CONTAINER" \
  --format "  {{.Names}}\t{{.Status}}"

HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$HOST_IP" ] && HOST_IP="localhost"

echo ""
echo "══════════════════════════════════════════════════════════"
echo "  ✅ Deploy complete!"
echo ""
echo "  🌐 App      → http://${HOST_IP}:${APP_PORT}"
echo "  📊 Temporal → http://${HOST_IP}:${TEMPORAL_UI_PORT}"
echo "                (workflows, schedules, history)"
echo "══════════════════════════════════════════════════════════"
echo ""
