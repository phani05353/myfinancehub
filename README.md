# MyFinanceHub

A self-hosted personal finance tracker. Import transactions via CSV, log income and expenses, track subscriptions, set bill reminders, attach receipts, auto-categorize with rules, and explore spending through a rich analytics dashboard — all running locally with no cloud dependency. Installable as a PWA on mobile.

## Features

- **Dashboard** — analytics-heavy home page:
  - Hero net card (income / spent / subscriptions) with animated accents
  - Savings rate bar + month progress ring
  - **Daily Spending Flow** chart (Chart.js) with MTD, daily average, and month-end projection
  - **vs Last Month** card — income, spending, net, and savings-rate deltas
  - **Top Merchants** with favicon logos and share bars
  - **Upcoming Bills** + **Top Spending** categories (radial dials)
  - **Largest Transactions** this month
  - **Spending by Day of the Week** (peak-day highlighted)
  - **Budget Overview** with per-category progress
  - Recent Transactions list
- **Transactions** — add / edit / delete with an Expense vs Income toggle (no manual sign entry), filter by month / category / payee / keyword, attach and preview **receipts** (JPG / PNG / WEBP / PDF)
- **Budgets** — per-category monthly limits with progress bars and over-limit warnings
- **Subscriptions** — track recurring charges; auto-detect from transaction history; one-click "Mark Paid" advances next-due date
- **Bill Reminders** — due-date tracking, recurring bills, overdue alerts in sidebar + mobile header
- **Charts** — spending by payee, category breakdown donut, multi-month income vs expenses trend
- **Year in Review** — year-end summary page with aggregate stats and highlights
- **Rules Engine** — auto-assign categories when transaction fields match conditions (contains / equals / starts_with / numeric comparators); apply to existing data in bulk
- **CSV Import & Export** — drag-and-drop import with duplicate detection; full export
- **Multi-User Auth** — bcrypt-hashed passwords, session cookies, admin / member roles, time-limited invite links, change-password flow
- **PWA** — installable on iOS / Android, service worker for offline shell, mobile bottom nav, safe-area insets for notched devices, dark theme throughout

## Stack

- **Backend**: Node.js + Express
- **Database**: SQLite (via `better-sqlite3`)
- **Auth**: `bcryptjs` + `express-session`
- **Frontend**: Vanilla HTML / CSS / JS (served as static files), Chart.js, PWA (service worker + manifest)
- **CSV**: `csv-parse`
- **File Uploads**: `multer` (CSVs and receipts)

## Getting Started

### Local (Node.js)

**Prerequisites:** Node.js 18+

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). The first visit redirects to `/setup` to create the admin user.

For auto-restart on file changes during development:

```bash
npm run dev
```

### Docker (recommended for homelab)

```bash
docker compose up
```

The app will be available at [http://localhost:3000](http://localhost:3000). The SQLite database is persisted via a bind mount so it survives container rebuilds.

**Run manually on a homelab (e.g. port 3090):**

```bash
# Create persistent directories on the host first
mkdir -p /home/youruser/finance-hub/data
mkdir -p /home/youruser/finance-hub/receipts

# Build and run
docker build -t home-finance .
docker run -d \
  --name home-finance \
  --restart unless-stopped \
  -p 3090:3000 \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -v /home/youruser/finance-hub/data:/app/data \
  -v /home/youruser/finance-hub/receipts:/app/uploads/receipts \
  home-finance
```

**Redeploy without losing data or receipts:**

```bash
docker stop home-finance && docker rm home-finance
docker build -t home-finance .
docker run -d --name home-finance --restart unless-stopped \
  -p 3090:3000 \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -v /home/youruser/finance-hub/data:/app/data \
  -v /home/youruser/finance-hub/receipts:/app/uploads/receipts \
  home-finance
```

Two bind mounts keep your data safe across rebuilds:
- `/app/data` — SQLite database
- `/app/uploads/receipts` — receipt images and PDFs

> **Schema note:** Adding new tables to `db/schema.sql` is safe (applied automatically on startup). Adding columns to *existing* tables requires a manual `ALTER TABLE` migration on the host database.

## Project Structure

```
myfinancehub/
├── server.js                 # Express API + app entry point
├── db/
│   └── schema.sql            # Database schema (auto-applied on startup)
├── public/
│   ├── index.html            # SPA shell
│   ├── login.html            # Sign-in page
│   ├── setup.html            # First-run admin bootstrap
│   ├── invite.html           # Invite acceptance
│   ├── manifest.json         # PWA manifest
│   ├── sw.js                 # Service worker
│   ├── css/style.css         # Dark theme, mobile-responsive
│   └── js/
│       ├── app.js            # Shared utils, router, dashboard
│       ├── transactions.js   # Incl. receipt upload, payee logos
│       ├── budget.js
│       ├── subscriptions.js
│       ├── reminders.js
│       ├── charts.js
│       ├── yearreview.js
│       ├── rules.js
│       └── import.js         # CSV import + export
├── scripts/
│   └── hash-password.js      # One-off bcrypt hash helper
├── data/                     # SQLite database (gitignored, created at runtime)
├── uploads/
│   ├── receipts/             # Receipt files (persisted via bind mount)
│   └── ...                   # Temporary CSV upload staging
├── Dockerfile
└── docker-compose.yml
```

## API Reference

All `/api/*` routes require an active session cookie (from `POST /auth/login`). Admin-only routes are noted.

### Auth & Users

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/setup` | First-run: create the initial admin user |
| POST | `/auth/login` | Log in and set session cookie |
| GET  | `/auth/logout` | Destroy session |
| POST | `/auth/change-password` | Change current user's password |
| POST | `/auth/invite` | Accept an invite token and create a member account |
| GET  | `/api/auth/me` | Current user `{ username, role }` |
| GET  | `/api/users` | List users (admin) |
| DELETE | `/api/users/:id` | Remove a non-admin user (admin) |
| POST | `/api/invites` | Generate a one-time invite link, 7-day expiry (admin) |

### Transactions & Receipts

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/transactions` | List (`month`, `payee`, `category`, `search`, `limit`, `offset`) |
| GET | `/api/transactions/:id` | Get single transaction |
| POST | `/api/transactions` | Create |
| PUT | `/api/transactions/:id` | Update |
| DELETE | `/api/transactions/:id` | Delete |
| GET | `/api/transactions/summary` | Income / expenses / net for a month |
| POST | `/api/transactions/:id/receipt` | Upload a receipt (JPG/PNG/WEBP/PDF, ≤10 MB) |
| DELETE | `/api/transactions/:id/receipt` | Remove the attached receipt |

### Budgets, Categories, Payees

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/budgets` | List monthly budgets |
| GET | `/api/budgets/status` | Spent vs budget per category for a month |
| POST | `/api/budgets` | Create or update a budget |
| DELETE | `/api/budgets/:id` | Remove a budget |
| GET | `/api/categories` | List categories |
| POST | `/api/categories` | Add a category |
| DELETE | `/api/categories/:name` | Remove a category |
| GET | `/api/payees` | Distinct payee suggestions |

### Subscriptions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/subscriptions` | List (`active=1` for active only) |
| GET | `/api/subscriptions/detect` | Suggest subscriptions from transaction history |
| GET | `/api/subscriptions/:id` | Get one |
| POST | `/api/subscriptions` | Create |
| PUT | `/api/subscriptions/:id` | Update |
| DELETE | `/api/subscriptions/:id` | Delete |
| POST | `/api/subscriptions/:id/pay` | Mark paid; advance `next_due_date` |

### Reminders

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/reminders` | List (`paid`, `upcoming_days`) |
| GET | `/api/reminders/detect` | Suggest recurring bills from history |
| GET | `/api/reminders/:id` | Get one |
| POST | `/api/reminders` | Create |
| PUT | `/api/reminders/:id` | Update |
| DELETE | `/api/reminders/:id` | Delete |
| POST | `/api/reminders/:id/pay` | Mark paid; roll recurring due date |

### Charts & Year in Review

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/charts/category-breakdown` | Spending by category for a month |
| GET | `/api/charts/monthly-by-payee` | Spending by payee for a month |
| GET | `/api/charts/spending-trend` | Income vs expenses over N months |
| GET | `/api/charts/available-months` | Months present in the DB (for pickers) |
| GET | `/api/year-review/:year` | Aggregated year-end summary |

### Rules Engine

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/rules` | List rules |
| POST | `/api/rules` | Create a rule |
| PUT | `/api/rules/:id` | Update a rule |
| DELETE | `/api/rules/:id` | Delete a rule |
| POST | `/api/rules/apply` | Apply rules to existing transactions |

### Import / Export

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/import/csv` | Upload and import a CSV file |
| GET | `/api/export/csv` | Download all transactions as CSV |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port the server listens on |
| `SESSION_SECRET` | random (per boot) | Secret used to sign session cookies. Set this in production so sessions survive restarts. |
| `NODE_ENV` | — | Set to `production` in Docker |

## Screenshots
<img width="1581" height="878" alt="Screenshot 2026-04-05 at 11 04 11 AM" src="https://github.com/user-attachments/assets/99bece77-4216-437b-b9ce-fb9744137dd3" />
<img width="1623" height="877" alt="Screenshot 2026-04-05 at 11 05 16 AM" src="https://github.com/user-attachments/assets/cd1bffed-0e95-47b5-8d6e-f6b3a4a74fba" />
<img width="1594" height="872" alt="Screenshot 2026-04-05 at 11 05 32 AM" src="https://github.com/user-attachments/assets/6153274c-f8a0-4516-bde8-e8f7e1b88fc9" />
<img width="479" height="580" alt="Screenshot 2026-04-05 at 11 05 51 AM" src="https://github.com/user-attachments/assets/c26cf836-472d-4833-89f9-b50950127461" />
