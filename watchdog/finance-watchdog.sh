#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# FinanceHub self-heal watchdog.
#
# Checks the app's /health; if it has been unreachable for THRESHOLD consecutive
# runs, re-runs deploy.sh to heal it. deploy.sh stops + removes the old container
# and re-creates it with `--network homelab-net -p 3090:3000`, which recovers the
# main failure mode we hit: the container getting orphaned off homelab-net after a
# reboot / network churn (the app stays "Up (healthy)" on its internal port but is
# unreachable from the host → 502). See home-lab-utils bug-248.
#
# Designed to run from the systemd timer (every ~2 min) as the docker-group user
# (no sudo needed — docker + git both work as that user; deploy.sh uses plain
# `docker`). A consecutive-fail THRESHOLD avoids reacting to a transient blip, and
# a COOLDOWN prevents redeploy loops.
#
# Edge case it does NOT auto-fix: a redeploy that fails with "address already in
# use :3090" because tailscale serve is holding the port. That needs
# `sudo systemctl restart tailscaled` then a redeploy — the Uptime Kuma monitor is
# the early-warning backstop for that case. NEVER kill the PID listening on :3090
# blindly; on this host that is tailscaled, not a stale proxy (home-lab bug-248).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

HEALTH_URL="${FINANCE_HEALTH_URL:-http://localhost:3090/health}"
DEPLOY="${FINANCE_DEPLOY:-$HOME/finance-hub/deploy.sh}"
STATE_DIR="${FINANCE_WATCHDOG_STATE_DIR:-$HOME/.local/state/finance-watchdog}"
THRESHOLD="${FINANCE_WATCHDOG_THRESHOLD:-3}"          # consecutive fails before healing
COOLDOWN_SECONDS="${FINANCE_WATCHDOG_COOLDOWN:-600}"  # min seconds between heals
CURL_TIMEOUT="${FINANCE_WATCHDOG_CURL_TIMEOUT:-8}"

mkdir -p "$STATE_DIR"
FAIL_FILE="$STATE_DIR/consecutive-fails"
LAST_HEAL_FILE="$STATE_DIR/last-heal-epoch"

log() { echo "$(date -u +%FT%TZ) finance-watchdog: $*"; }

# 1. Health probe — /health returns 200; treat any reachable response as alive so
#    a redirect (auth gate) still counts as "the server is up".
code="$(curl -fsS -o /dev/null -m "$CURL_TIMEOUT" -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || true)"
if [[ "$code" =~ ^(200|301|302)$ ]]; then
  [ -f "$FAIL_FILE" ] && rm -f "$FAIL_FILE"   # healthy → reset the counter
  exit 0
fi

# 2. Unhealthy → bump the consecutive-fail counter.
fails=$(( $(cat "$FAIL_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$fails" > "$FAIL_FILE"
log "health check failed (http='${code:-none}') — consecutive=${fails}/${THRESHOLD}"
[ "$fails" -lt "$THRESHOLD" ] && exit 0

# 3. Threshold reached → respect the cooldown so we never loop on a deploy that
#    can't fix the problem.
now=$(date +%s)
last=$(cat "$LAST_HEAL_FILE" 2>/dev/null || echo 0)
if [ $(( now - last )) -lt "$COOLDOWN_SECONDS" ]; then
  log "threshold reached but within cooldown ($(( now - last ))s < ${COOLDOWN_SECONDS}s) — skipping heal"
  exit 0
fi

# 4. Heal — re-run the deploy.
echo "$now" > "$LAST_HEAL_FILE"
if [ ! -x "$DEPLOY" ]; then
  log "ERROR: deploy script not found / not executable at '$DEPLOY' (set FINANCE_DEPLOY)"
  exit 1
fi
log "HEALING — finance unreachable ${fails}× — running $DEPLOY"
if "$DEPLOY"; then
  log "deploy completed; re-verifying on the next tick"
  rm -f "$FAIL_FILE"
else
  rc=$?
  log "ERROR: deploy exited ${rc} — manual check needed (e.g. tailscale serve holding :3090 → 'sudo systemctl restart tailscaled' then redeploy)"
  exit "$rc"
fi
