# MyFinanceHub

A self-hosted personal finance tracker for households. Import transactions via CSV, log income and expenses, track subscriptions, set bill reminders, attach receipts, auto-categorize with a rules engine, and explore spending through a rich analytics dashboard. Now with **real-time Web Push notifications** orchestrated by **Temporal** workflows — bill reminders, budget alerts, price-hike detection, daily recap, a weekly digest, monthly close summaries, and auto-detected **trip tracking** all land on your phone's lock screen exactly when they should. Reliability is baked in via **nightly verified SQLite backups** and a **weekly integrity check** that pages you on corruption. All runs locally, no cloud dependency. Installable as a PWA on mobile and desktop.

## Features

### Dashboard
Analytics-first home page with a Monarch Money-style layout — pill navigation on desktop, bottom nav on mobile.

- **Cumulative spending area chart** — MTD spend vs last month's pace, with month-end projection
- **Smart Insights widget** — 4 dynamic, data-driven observations (MoM pace change, biggest category swing, day-of-week pattern, top merchant) computed from existing data — none hard-coded
- **Subscription price-hike alerts** — red-bordered card at the top whenever a recurring charge crept up vs its expected amount
- **Category breakdown** — sticky right panel with donut chart, per-category sparklines (6-month trend), and share percentages
- **Income & savings rate** — dual bar showing spent vs saved, color-coded by savings health
- **Savings goals card** — active goals shown as saved / target with a progress bar and pace info (amount/month needed to hit the target date); clickable to manage
- **Largest transactions**, **upcoming bills**, **budget overview**, **cash flow + Sankey** ("Where Money Flows") — clickable, drill into the underlying transactions modal
- **Greeting** with display name (configurable per user)

### Charts
- **Spending Heatmap** — GitHub contribution-graph style full-year calendar; each day color-coded by spend intensity (percentile-based palette); click a day → its transactions
- **Category Trend** — multi-line cumulative chart per category across 3 / 6 / 12 months; compare within-month pace and totals at a glance
- **Per-Merchant Trend modal** — click any payee anywhere in the app → modal with the same cumulative-per-month chart scoped to that merchant. Shows MTD vs same-day-last-month with a percent delta.
- **Spending by Payee**, **Category Breakdown**, **Income vs Expenses Trend**, **Top Payees detail** — all clickable, all drill into filtered transactions

### Transactions
- Add / edit / delete with an **Expense vs Income toggle**
- **Smart category suggester** — tab out of the payee field and the category auto-fills based on your history with that merchant
- **Receipt OCR auto-fill** — attach an image receipt and Tesseract.js reads it locally (no cloud, no LLM, no network calls during inference). Payee and amount fields pre-fill from common patterns like `TOTAL $X.XX` headers. Editable before save.
- Filter by month / category / payee / keyword
- **Receipt attachments** — upload JPG / PNG / WEBP / PDF (≤10 MB)
- **In-app receipt preview** — click any transaction with a receipt anywhere in the app → image or PDF renders inside the modal (no new tabs)
- Pagination, mobile card layout

### Budget
- Per-category monthly limits with color-coded progress bars (green / amber / red)
- Click any category card → modal with all transactions for that month
- Dashboard rows are also clickable into the same modal

### Savings Goals
- Forward-looking savings targets — name, target amount, optional target date, and notes
- Per-goal progress bars and **pace info** (the monthly contribution needed to hit the target date, or a past-due warning)
- **Log contributions** that increment the saved amount; negative amounts allowed for corrections
- Archive goals (keep history without cluttering the active list) and a 🎉 reached state
- Periodic **Temporal nudge push** — celebrates a reached goal, warns when you've fallen behind pace, or gently reminds you to contribute (skips silently when there's nothing to say)

### Subscriptions
- Track recurring charges with billing cycle (weekly / monthly / yearly)
- **Mark Paid** advances next-due date and **auto-creates a transaction**, *unless* a matching transaction already exists (±5 days, ±2% amount tolerance)
- Auto-detect subscription candidates from transaction history

### Bill Reminders
- Due-date tracking with optional recurring roll
- **Mark Paid** rolls the due date and auto-creates a transaction with the same dedup logic
- Overdue count badge in sidebar / mobile header dot

### Push Notifications (PWA)
Two sources fire pushes — **scheduled** alerts from Temporal workflows, and **event-driven** alerts triggered by user actions.

**Scheduled (Temporal workflows, cron-driven):**

| When | What |
|---|---|
| Daily, 6 AM | ✈️ Trip detection scan — clusters of new payees spawn a per-trip tracker workflow that pushes a summary when activity dies down |
| Daily, 8 AM | 🔔 Bills due tomorrow + any overdue bills |
| Daily, 9 AM | 📈 Subscription price hikes detected |
| Daily, 8 PM | 💰 Budget categories at ≥90% of limit |
| Every 3 days, 7 PM | 🎯 Savings goal nudge — celebrate a reached goal, warn about a behind-pace goal, or gently remind to contribute |
| Daily, 9 PM | 📊 Daily recap — what you spent today |
| Sunday, 6 PM | 💡 Weekly insights digest |
| 1st of month, 8 AM | 📅 Month-end close — spent, income, net, top category for the prior month |
| Daily, 3 AM | 💾 Verified SQLite backup (silent on success; pushes only on failure) |
| Sunday, 4 AM | 🚨 Database integrity check (pushes only on corruption) |
| Every 3 days, 4 AM | 🧹 Prune push subscriptions stale > 30 days |

**Event-driven (real-time, fanned out via web-push):**

| Trigger | Sent to | Body |
|---|---|---|
| Transaction added | All other subscribed devices in the household (originator excluded via `X-Push-Endpoint` header) | `💸 Maruthi added a transaction · Costco · -$87.34 · Groceries`<br>`Groceries: 67% of May ($340 of $500)` |
| Income added | All other subscribed devices | `💰 Maruthi logged income · Paycheck · +$2,400.00`<br>`May net so far: +$1,820.00` |

The push body is **dynamic** — for expenses, the second line is whichever of these has the most signal: % of monthly budget if the category has one, deviation from the 180-day average at that merchant, or today's running expense total. For income, it's MTD net. Falls back to the bare payee + amount line if nothing meaningful is computable.

All notifications skip silently when there's nothing to say — no notification fatigue. Each notification deep-links to the relevant page when tapped. Every push attempt — scheduled or event-driven — flows through a Temporal workflow, so retries, payloads, and timing are all visible in the Temporal UI.

**Requires HTTPS.** Web Push is a secure-context-only API — iOS Safari, Chrome, and Firefox all refuse `pushManager.subscribe()` over plain HTTP except on `localhost`. The recommended path for a homelab is **Tailscale serve** (free, real Let's Encrypt cert, end-to-end encrypted, no router config). See [Enabling HTTPS for Push](#enabling-https-for-push).

### Trip Detection
- Fully automatic — no manual "I'm on a trip" toggle
- Daily 6 AM scan looks for clusters of **new payees** (merchants never seen before in your history) appearing in the last 7 days
- ≥3 new payees spawns a per-trip workflow that sleeps in 2-day chunks until the cluster goes quiet, then pushes a single summary: date range, transaction count, total, top category
- Tiny clusters (<3 transactions or <$50 total) are skipped — no notification for a single weekend errand
- Workflow IDs are derived from trip-start date, so duplicate detection is idempotent — the same trip never gets tracked twice

### Reliability
- **Online SQLite backups** every night at 3 AM using SQLite's `db.backup()` API — safe while the app keeps reading/writing
- Each backup is **verified immediately** with `PRAGMA integrity_check` on the copy; corrupted backups are deleted and the workflow fails loudly so Temporal retries surface the issue
- **14-day retention** — older backups pruned automatically
- **Weekly integrity check** (Sunday 4 AM) runs `PRAGMA integrity_check` on the live DB and pushes a CRITICAL alert to every subscribed device with the diagnosis and the latest available backup name if corruption is detected
- **Push subscription self-cleanup** — dead endpoints are removed live on 404/410; the every-3-days cleanup workflow handles the long-tail rot (uninstalled PWAs, revoked permissions, silent devices) by pruning subscriptions whose `last_seen` is older than 30 days
- Backups live in `data/backups/` next to `finance.db` — same bind mount, preserved across deploys

### Year in Review
- Year picker auto-populated from years with transaction data
- Annual income, expenses, net savings, savings rate
- Monthly grouped bar chart, category donut, month-by-month table, top 5 expenses
- All charts clickable → drill into transactions for that month/category

### Rules Engine
- IFTTT-style auto-categorization rules
- Conditions on `payee`, `notes`, or `amount` using `contains / equals / starts_with / ends_with / gt / lt / gte / lte / eq`
- Rules run on every new transaction and every CSV import row
- Bulk-apply to existing transactions

### CSV Import & Export
- Drag-and-drop CSV upload with auto column detection and duplicate detection
- Full transaction export as CSV

### Auth — Authentik SSO (OIDC)
- Login is delegated to a self-hosted **Authentik** instance (stood up by the
  [home-lab-utils](https://github.com/phani05353/home-lab-utils) repo: `./authentik.sh up`).
  No passwords are stored or managed in this app — user/role management lives in Authentik.
- `openid-client` + `express-session` cookies (7-day, httpOnly, SameSite=Lax; no
  `Secure` flag since the homelab runs over plain HTTP)
- **Admin / Member roles** — the **first** user to log in becomes admin, everyone
  after is a member; all users share household data
- **Display name** per user (from the OIDC `name` claim) — shown in the dashboard greeting
- Existing local accounts are linked on first OIDC login by email/username, so
  history and push subscriptions carry over

### Mobile / PWA
- Installable on iOS / Android / desktop
- Offline app shell (network-only for `/api/`)
- Network-first service worker — deploys are picked up on the next page load, no stale-asset glitches
- Bottom nav on mobile, hamburger sidebar for secondary pages
- `env(safe-area-inset-*)` respect — notch & home-indicator safe on iPhone
- Dark theme throughout
- **Customizable home-screen icon** — edit constants in [scripts/generate-icons.py](scripts/generate-icons.py) (`ACCENT`, `FG`, `SYMBOL`) and re-run to regenerate all three sizes (192/512/180). Bump `CACHE` in [public/sw.js](public/sw.js) so installed PWAs refresh.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 (Debian slim) |
| Web framework | Express |
| Database | SQLite via `better-sqlite3` |
| Auth | Authentik SSO via `openid-client` (OIDC) + `express-session` |
| Charts | Chart.js 4 |
| File uploads | `multer` |
| CSV parsing | `csv-parse` |
| **Workflows** | **Temporal** (`@temporalio/worker` + `@temporalio/client`) |
| **Push** | **`web-push`** with auto-generated VAPID keys |
| **OCR** | **`tesseract.js`** — WASM-bundled Tesseract LSTM, English model, runs locally |
| Frontend | Vanilla HTML / CSS / JS (no framework) |

---

## Getting Started

### Local (Node.js)

**Prerequisites:** Node.js 20+ and pnpm (via `corepack enable` — the version is pinned in `package.json`).

```bash
pnpm install
pnpm start
```

Open [http://localhost:3000](http://localhost:3000). Any unauthenticated request redirects to Authentik to log in (set the `OIDC_*` env vars first — see [.env.example](.env.example) and the [home-lab-utils Authentik setup](https://github.com/phani05353/home-lab-utils#authentik-sso)). The **first** user to log in becomes the admin.

If a Temporal server isn't reachable on `localhost:7233`, the app logs a warning and runs **without notifications**. All other features work normally. Set `TEMPORAL_DISABLED=1` to silence the warning.

### Homelab Deploy (recommended)

The `deploy.sh` script brings up **two containers** on a private docker network — no docker-compose required.

**Layout:**
```
finance-hub/
├── deploy.sh             ← this script
├── myfinancehub/         ← git repo (auto-cloned on first run)
├── container-data/       ← SQLite DB        (preserved across deploys)
└── container-receipts/   ← receipt files    (preserved across deploys)
```

```bash
mkdir -p /home/youruser/finance-hub
cd /home/youruser/finance-hub
curl -O https://raw.githubusercontent.com/phani05353/myfinancehub/main/deploy.sh
chmod +x deploy.sh
./deploy.sh
```

What the script does:

1. **Pulls** the latest code (clones first run, `git pull` after)
2. **Builds** the app image (`home-finance`)
3. **Ensures** a private docker network exists (`home-finance-net`)
4. **Starts Temporal** (`temporalio/auto-setup:1.24.2`) — Web UI exposed on **:8090**
5. **Starts the app** wired to Temporal — exposed on **:3090**
6. **Verifies** both containers are running

Re-run `./deploy.sh` any time to pull the latest code and rebuild — data is preserved.

**Ports:**
- `:3090` — the app
- `:8090` — Temporal Web UI (workflows, schedules, history)

VAPID keys are generated and persisted in the SQLite DB on first boot — no manual setup.

---

## Enabling HTTPS for Push

Web Push is a **secure-context-only** browser API. Both iOS Safari and desktop browsers reject `pushManager.subscribe()` over plain HTTP unless the host is `localhost`. To make push work for your homelab from any device, you need HTTPS.

**Recommended: Tailscale serve.** Free, real Let's Encrypt cert auto-managed, end-to-end encrypted between your devices, no router port forwards, no public exposure.

```bash
# On the homelab host
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up        # opens an auth URL — sign in

# In the Tailscale admin console → DNS:
#   1. Enable MagicDNS (if not already)
#   2. Enable HTTPS Certificates

# Expose the finance app over HTTPS on your tailnet (NOT publicly):
sudo tailscale serve --bg --https=443 http://localhost:3090
sudo tailscale serve status   # prints your https://<machine>.<tail-net>.ts.net URL
```

Install the **Tailscale iOS app** and sign in with the same account. Your iPhone joins your tailnet — open the HTTPS URL from above in Safari and you'll get a valid cert. Push notifications work after that.

Alternatives if you don't want Tailscale: Cloudflare Tunnel with a domain, or `mkcert` with a self-signed root CA installed on every device.

---

## How to Subscribe to Push Notifications

Web Push works on **iOS 16.4+ and all modern Android / desktop browsers**, but **only when the app is installed as a PWA and served over HTTPS** (see [Enabling HTTPS for Push](#enabling-https-for-push)).

### iOS / iPad (Safari)

1. Open the app URL (`http://your-homelab-ip:3090`) in **Safari**
2. Tap the **Share** button (square with arrow) → **Add to Home Screen** → **Add**
3. Open the installed app from the home screen (not Safari)
4. Tap the **avatar in the top-right** (or **Edit Profile** in the sidebar)
5. On the **🔔 Push Notifications** row, tap **Enable**
6. Tap **Allow** when iOS asks for permission
7. Tap **Send test notification** — you should get a banner within ~2 seconds
8. Repeat on each device you want notifications on (iPhone, iPad, laptop — each subscribes independently)

### Android (Chrome / Edge / Firefox)

1. Open the app URL in Chrome
2. Tap the menu (⋮) → **Install app** (or **Add to Home Screen**)
3. Open the installed app
4. Tap your avatar → **Edit Profile**
5. Tap **Enable** on the Push Notifications row → **Allow**
6. Tap **Send test notification** to verify

### Desktop (Chrome / Edge / Firefox)

1. Open the app URL
2. Look for the **install icon** in the URL bar (`⊕` or a small computer icon) and click **Install**
3. From the installed app, click your avatar → **Edit Profile**
4. Click **Enable** on Push Notifications → **Allow**

### Troubleshooting

- **"Not supported in this browser"** — you're viewing it inside a regular browser tab. Install the PWA first.
- **Permission denied** — iOS / browser blocked push at the OS level. Settings → Notifications → [Your app] → allow.
- **Enabled but never receiving** — open Temporal UI at `:8090`, click **Schedules**, find a workflow, click **Trigger Immediately**. If it fires (visible in **Workflows** tab) and you still don't get a notification, the subscription is dead — disable and re-enable in the app to refresh the endpoint.
- **Test notification works but scheduled ones don't** — check that your homelab clock is in the timezone you expect. Cron expressions in [temporal/worker.js](temporal/worker.js) use the Temporal server's local time.

### Per-Device, Per-User

Each device on each browser subscribes separately. Phone notifications and laptop notifications are independent — disabling on one doesn't disable the other. Subscriptions are tied to your user, so when you sign in on a new device the prior subscription doesn't carry over (each device must opt in once).

To stop notifications on a device: open Edit Profile → tap **Disable**. The subscription is removed both from the server and from the browser.

---

## Watching the Workflows

Open **http://your-homelab-ip:8090** to see the Temporal Web UI.

- **Workflows tab** — every run (succeeded / failed / running), full input/output, retry attempts, per-activity timing. This includes the event-driven `sendPushWorkflow` runs that fire on each transaction add and the per-trip `tripDetectionWorkflow` runs spawned by the daily scanner.
- **Schedules tab** — eleven cron jobs registered automatically by the worker on startup:
  - `bills-daily` (08:00 daily)
  - `price-hikes-daily` (09:00 daily)
  - `budget-threshold-daily` (20:00 daily)
  - `savings-nudge` (19:00 every 3 days)
  - `daily-recap` (21:00 daily)
  - `weekly-insights` (Sunday 18:00)
  - `month-end-close` (1st of month, 08:00)
  - `trip-detection` (06:00 daily)
  - `daily-backup` (03:00 daily)
  - `weekly-integrity-check` (Sunday 04:00)
  - `push-cleanup` (every 3 days, 04:00)
- **Trigger Immediately** — useful to test a workflow without waiting for its cron. Each schedule has a button on its detail page.

Schedule definitions live in [temporal/worker.js](temporal/worker.js#L12). Edit cron expressions there and the worker re-registers on next start (idempotent via `ensureSchedule`).

---

## Project Structure

```
myfinancehub/
├── server.js                 # Express API + app entry point + worker bootstrap
├── temporal/                 # Temporal workflow engine integration
│   ├── activities.js         # I/O units: DB queries, push sending
│   ├── workflows.js          # Workflow definitions (deterministic, no I/O)
│   └── worker.js             # Worker + schedule registration
├── db/
│   └── schema.sql            # Database schema (auto-applied on startup)
├── public/
│   ├── index.html            # SPA shell
│   ├── manifest.json         # PWA manifest
│   ├── sw.js                 # Service worker — push event handler
│   ├── css/style.css
│   └── js/
│       ├── app.js            # Shared utilities, router, dashboard, push subscribe
│       ├── transactions.js
│       ├── budget.js
│       ├── subscriptions.js
│       ├── reminders.js
│       ├── charts.js
│       ├── yearreview.js
│       ├── rules.js
│       └── import.js
├── scripts/
│   └── generate-icons.py     # Regenerates PWA icons from the homepage logo design
├── data/                     # SQLite database (gitignored)
│   └── backups/              # Nightly verified backups (14-day retention)
├── uploads/receipts/         # Receipt files (gitignored)
├── deploy.sh                 # Two-container homelab deploy
├── Dockerfile                # Debian slim for Temporal SDK compatibility
└── docker-compose.yml        # Optional alternative to deploy.sh
```

---

## API Reference

All `/api/*` routes require an active session cookie. Admin-only routes are noted.

### Health

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Returns `{ status: "healthy" }` — used by Docker HEALTHCHECK |

### Auth (Authentik OIDC)

| Method | Path | Description |
|---|---|---|
| GET  | `/auth/login` | Start the OIDC flow — redirects to Authentik (PKCE + state + nonce) |
| GET  | `/auth/callback` | OIDC redirect target — validates the code, provisions/links the user, opens the session |
| GET  | `/auth/logout` | Destroy the session (and bounce through Authentik's end-session endpoint if configured) |
| POST | `/auth/profile` | Update display name |
| GET  | `/api/auth/me` | Current user `{ username, role, display_name }` |

### Push Notifications

| Method | Path | Description |
|---|---|---|
| GET  | `/api/push/vapid-public-key` | The server's VAPID public key (for `pushManager.subscribe`) |
| POST | `/api/push/subscribe` | Register a device subscription |
| POST | `/api/push/unsubscribe` | Remove a device subscription |
| GET  | `/api/push/status` | Count of active subscriptions for the current user |
| POST | `/api/push/test` | Send a one-off "test" notification to all of this user's devices |

### Transactions & Receipts

| Method | Path | Description |
|---|---|---|
| GET | `/api/transactions` | List — params: `month`, `year`, `date`, `payee`, `category`, `search`, `limit`, `offset` |
| GET | `/api/transactions/:id` | Get single transaction |
| POST | `/api/transactions` | Create (rules auto-applied) |
| PUT | `/api/transactions/:id` | Update |
| DELETE | `/api/transactions/:id` | Delete (cleans up the receipt file too) |
| GET | `/api/transactions/summary` | `{ income, expenses, net }` for a month |
| POST | `/api/transactions/:id/receipt` | Upload receipt (≤10 MB) |
| DELETE | `/api/transactions/:id/receipt` | Remove attached receipt |
| POST | `/api/receipts/ocr` | OCR a receipt image (in-memory, not stored) → `{ payee, amount, confidence }` |

`POST /api/transactions` accepts an optional `X-Push-Endpoint` header — when present, the server excludes that endpoint from the cross-device transaction-added notification, so the originating device doesn't ding itself.

### Budgets & Categories

| Method | Path | Description |
|---|---|---|
| GET | `/api/budgets` | List monthly budgets |
| GET | `/api/budgets/status` | Spent vs budget per category for a month |
| POST | `/api/budgets` | Upsert a budget |
| DELETE | `/api/budgets/:id` | Remove a budget |
| GET | `/api/categories` | List categories |
| POST | `/api/categories` | Add a category |
| DELETE | `/api/categories/:name` | Remove a category |
| GET | `/api/payees` | Distinct payee names |
| GET | `/api/payees/suggest-category` | Smart category suggestion for a given payee |

### Savings Goals

| Method | Path | Description |
|---|---|---|
| GET | `/api/savings-goals` | List goals — `?active=1` for active only |
| GET | `/api/savings-goals/:id` | Get one |
| POST | `/api/savings-goals` | Create a goal (`name`, `target_amount`, optional `saved_amount`, `target_date`, `notes`) |
| PUT | `/api/savings-goals/:id` | Update a goal (any field, incl. `active` to archive) |
| DELETE | `/api/savings-goals/:id` | Delete a goal |
| POST | `/api/savings-goals/:id/contribute` | Add a contribution (`amount`; negative allowed for corrections) — returns `{ goal, reached }` |

### Subscriptions

| Method | Path | Description |
|---|---|---|
| GET | `/api/subscriptions` | List — `?active=1` for active only |
| GET | `/api/subscriptions/detect` | Suggest subscriptions from transaction history |
| GET | `/api/subscriptions/price-alerts` | Active subscriptions whose most recent charge exceeds expected |
| GET | `/api/subscriptions/:id` | Get one |
| POST | `/api/subscriptions` | Create |
| PUT | `/api/subscriptions/:id` | Update |
| DELETE | `/api/subscriptions/:id` | Delete |
| POST | `/api/subscriptions/:id/pay` | Mark paid — advances date, creates a transaction if none exists |

### Reminders

| Method | Path | Description |
|---|---|---|
| GET | `/api/reminders` | List — params: `paid`, `upcoming_days` |
| GET | `/api/reminders/detect` | Suggest recurring bills from history |
| GET | `/api/reminders/:id` | Get one |
| POST | `/api/reminders` | Create |
| PUT | `/api/reminders/:id` | Update |
| DELETE | `/api/reminders/:id` | Delete |
| POST | `/api/reminders/:id/pay` | Mark paid — rolls recurring date, creates a transaction if none exists |

### Charts & Analytics

| Method | Path | Description |
|---|---|---|
| GET | `/api/charts/category-breakdown` | Spending by category for a month |
| GET | `/api/charts/category-monthly` | Per-category over N months (for sparklines) |
| GET | `/api/charts/category-trend` | Daily per-category spending over N months |
| GET | `/api/charts/payee-trend` | Daily spending for one payee over N months |
| GET | `/api/charts/monthly-by-payee` | Spending by payee for a month |
| GET | `/api/charts/spending-trend` | Income vs expenses over N months |
| GET | `/api/charts/spending-heatmap` | Daily expense totals for a year — `?year=YYYY` |
| GET | `/api/charts/available-months` | Months with transaction data |
| GET | `/api/year-review/:year` | Aggregated year-end stats |

### Rules Engine

| Method | Path | Description |
|---|---|---|
| GET | `/api/rules` | List rules |
| POST | `/api/rules` | Create a rule |
| PUT | `/api/rules/:id` | Update or toggle a rule |
| DELETE | `/api/rules/:id` | Delete a rule |
| POST | `/api/rules/apply` | Bulk-apply all enabled rules to existing transactions |

### Import / Export

| Method | Path | Description |
|---|---|---|
| POST | `/api/import/csv` | Upload and import a CSV file |
| GET | `/api/export/csv` | Download all transactions as CSV |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `SESSION_SECRET` | auto-generated | Signs session cookies. Auto-persisted in SQLite on first boot. |
| `TEMPORAL_ADDRESS` | `localhost:7233` | gRPC address of the Temporal server |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `TEMPORAL_DISABLED` | — | Set to `1` to skip starting the worker entirely |
| `VAPID_SUBJECT` | `mailto:admin@home-finance.local` | Subject used in VAPID JWTs sent to push services |
| `NODE_ENV` | — | Set to `production` in the Docker image |

VAPID public/private keys are generated on first boot and persisted in the SQLite DB. You don't need to set them as env vars.

---

## Screenshots

<img width="1581" height="878" alt="Dashboard" src="https://github.com/user-attachments/assets/99bece77-4216-437b-b9ce-fb9744137dd3" />
<img width="1623" height="877" alt="Transactions" src="https://github.com/user-attachments/assets/cd1bffed-0e95-47b5-8d6e-f6b3a4a74fba" />
<img width="1594" height="872" alt="Charts" src="https://github.com/user-attachments/assets/6153274c-f8a0-4516-bde8-e8f7e1b88fc9" />
<img width="647" height="581" alt="Screenshot 2026-06-13 at 4 20 08 AM" src="https://github.com/user-attachments/assets/239430b9-d05d-4f2b-983c-27806ea7bf25" />

