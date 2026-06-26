# FinanceHub self-heal watchdog

A tiny systemd timer that checks the app's `/health` every ~2 minutes and, if it's
been unreachable for a few consecutive checks, re-runs `deploy.sh` to heal it.

## Why

FinanceHub (`home-finance`) runs on the shared `homelab-net` docker network, which
is managed by the *home-lab-utils* tooling. A reboot or network churn can orphan
the container off that network: the app keeps reporting **"Up (healthy)"** on its
internal port (the healthcheck is namespace-local) while the host port `3090` is
dead — so it silently 502s and docker never restarts it. Recreating the container
via `deploy.sh` (which re-attaches `homelab-net` and re-publishes `3090:3000`) is
the reliable fix. See home-lab-utils **bug-248**.

## Install (on the homelab box)

```bash
# from the repo checkout (e.g. ~/finance-hub/myfinancehub)
sudo cp watchdog/finance-watchdog.service watchdog/finance-watchdog.timer /etc/systemd/system/

# IMPORTANT: confirm the paths/User in the .service match your box. Defaults:
#   User=phanikumar
#   FINANCE_DEPLOY=/home/phanikumar/finance-hub/deploy.sh
#   ExecStart=/home/phanikumar/finance-hub/myfinancehub/watchdog/finance-watchdog.sh
sudoedit /etc/systemd/system/finance-watchdog.service   # if your layout differs

sudo systemctl daemon-reload
sudo systemctl enable --now finance-watchdog.timer
```

## Verify

```bash
systemctl list-timers finance-watchdog          # next/last run
journalctl -u finance-watchdog -n 30 --no-pager # watchdog log
# force a run now:
sudo systemctl start finance-watchdog.service
```

## Tunables (env in the `.service`)

| Var | Default | Meaning |
| --- | --- | --- |
| `FINANCE_HEALTH_URL` | `http://localhost:3090/health` | what to probe |
| `FINANCE_DEPLOY` | `$HOME/finance-hub/deploy.sh` | heal command |
| `FINANCE_WATCHDOG_THRESHOLD` | `3` | consecutive fails before healing |
| `FINANCE_WATCHDOG_COOLDOWN` | `600` | min seconds between heals (anti-loop) |

## What it does NOT auto-fix

A redeploy that fails with `address already in use :3090` because **tailscale
serve** is holding the port. On this host the listener on `:3090` is `tailscaled`,
**not** a stale docker-proxy — never blind-kill it. Recover with
`sudo systemctl restart tailscaled` then a redeploy. The Uptime Kuma monitor on
`:3090/health` is the early-warning backstop for this case.
