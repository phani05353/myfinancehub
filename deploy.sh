#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# MyFinanceHub — homelab deploy script
# Run from: /home/phanikumar/finance-hub/
#
# Layout expected:
#   finance-hub/
#   ├── deploy.sh             ← this script
#   ├── myfinancehub/         ← git repo (auto-cloned if missing)
#   ├── container-data/       ← SQLite DB  (never touched)
#   └── container-receipts/   ← receipts   (never touched)
# ─────────────────────────────────────────────────────────────────────────────
set -e

REPO_URL="https://github.com/phani05353/myfinancehub"
REPO_DIR="myfinancehub"
IMAGE_NAME="home-finance"
CONTAINER_NAME="home-finance"
BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   MyFinanceHub — Deploy             ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── 1. Pull latest code ───────────────────────────────────────────────────────
echo "▶ Step 1/4 — Updating source code..."
if [ -d "$BASE_DIR/$REPO_DIR/.git" ]; then
  cd "$BASE_DIR/$REPO_DIR"
  git pull
else
  echo "  Repo not found — cloning..."
  cd "$BASE_DIR"
  git clone "$REPO_URL" "$REPO_DIR"
fi
echo "  ✓ Source up to date"

# ── 2. Build Docker image ─────────────────────────────────────────────────────
echo ""
echo "▶ Step 2/4 — Building Docker image..."
cd "$BASE_DIR/$REPO_DIR"
sudo docker build -t "$IMAGE_NAME" .
echo "  ✓ Image built"

# ── 3. Stop + remove old container (data volumes are untouched) ───────────────
echo ""
echo "▶ Step 3/4 — Replacing container..."
sudo docker stop "$CONTAINER_NAME" 2>/dev/null && echo "  Stopped old container" || echo "  No running container found"
sudo docker rm   "$CONTAINER_NAME" 2>/dev/null && echo "  Removed old container" || true

# ── 4. Start new container ────────────────────────────────────────────────────
echo ""
echo "▶ Step 4/4 — Starting new container..."
sudo docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -p 3090:3000 \
  -v "$BASE_DIR/container-data:/app/data" \
  -v "$BASE_DIR/container-receipts:/app/uploads/receipts" \
  "$IMAGE_NAME"

echo "  ✓ Container started"
echo ""
echo "══════════════════════════════════════════"
echo "  ✅ Deploy complete!"
echo "  🌐 http://$(hostname -I | awk '{print $1}'):3090"
echo "══════════════════════════════════════════"
echo ""
