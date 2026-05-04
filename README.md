# MyFinanceHub

A self-hosted personal finance tracker for households. Import transactions via CSV, log income and expenses, track subscriptions, set bill reminders, attach receipts, auto-categorize with a rules engine, and explore spending through a rich analytics dashboard — all running locally with no cloud dependency. Installable as a PWA on mobile and desktop.

## Features

### Dashboard
Analytics-first home page with a Monarch Money-style layout — pill navigation on desktop, bottom nav on mobile.

- **Cumulative spending area chart** — MTD spend vs last month's pace, with month-end projection
- **Category breakdown** — sticky right panel with donut chart, per-category sparklines (6-month trend), and share percentages
- **Income & savings rate** — dual bar showing spent vs saved, color-coded by savings health
- **Largest transactions** this month
- **Upcoming bills** — next 30 days at a glance
- **Budget overview** — per-category progress bars with over-limit warnings
- **Cash flow & Sankey diagram** — income → category flow visualization
- Overdue bill badge on mobile header

### Transactions
- Add / edit / delete with an **Expense vs Income toggle** (amount always positive, sign applied automatically)
- Filter by month, category, payee, or keyword
- **Receipt attachments** — upload JPG / PNG / WEBP / PDF (≤10 MB), previewed in-app
- **Payee logos** — DuckDuckGo favicon lookup with colored-initial fallback; green `$` badge for income
- Pagination, mobile card layout

### Budget
- Per-category monthly limits with color-coded progress bars (green / amber / red)
- Click any category card → modal with all transactions for that month
- Cards sorted by % used descending

### Subscriptions
- Track recurring charges with billing cycle (weekly / monthly / yearly)
- **Mark Paid** advances next-due date and **auto-creates a transaction** in the ledger
- Auto-detect subscription candidates from transaction history

### Bill Reminders
- Due-date tracking with optional recurring roll (configurable interval in days)
- **Mark Paid** rolls the due date and **auto-creates a transaction** if an amount is set
- Overdue count badge in sidebar and mobile header dot

### Charts
- **Spending Heatmap** — GitHub contribution-graph style full-year calendar; each day is color-coded by spend intensity (percentile-based, amber → gold palette); hover tooltip shows date + amount; year selector
- **Spending by Payee** — horizontal bar chart for the selected month
- **Category Breakdown** — donut chart for the selected month
- **Income vs Expenses Trend** — grouped bar chart over 3 / 6 / 12 months
- **Top Payees detail table** — txn count, total, and share bar

### Year in Review
- Year picker auto-populated from years with transaction data
- Annual income, expenses, net savings, and savings rate
- Monthly grouped bar chart, category donut, month-by-month table
- Highlights: best savings month, highest spending month, top 5 expenses

### Rules Engine
- IFTTT-style auto-categorization rules
- Conditions on `payee`, `notes`, or `amount` using `contains / equals / starts_with / ends_with / gt / lt / gte / lte / eq`
- Action: `set_category`
- Rules run automatically on every new transaction and every CSV import row
- Toggle enable/disable per rule; bulk-apply to all existing transactions
- Priority ordering — last matching rule wins

### CSV Import & Export
- Drag-and-drop CSV upload with auto column detection
- Duplicate detection (skips rows already in DB)
- Full transaction export as CSV

### Multi-User Auth
- bcrypt-hashed passwords, `express-session` cookies (7-day, httpOnly)
- **Admin / Member roles** — admins manage users and generate invites; all users share household data
- Time-limited invite links (7-day expiry, one-time use)
- Change-password flow for all users

### PWA & Mobile
- Installable on iOS / Android / desktop via Web App Manifest + Service Worker
- Offline app shell (all JS/CSS pre-cached; API calls always hit the network)
- Bottom navigation bar on mobile; hamburger sidebar for secondary pages
- `env(safe-area-inset-*)` insets — notch and home indicator safe on iPhone
- Dark theme throughout

### Infrastructure
- `GET /health` endpoint for container health checks
- Docker `HEALTHCHECK` — Portainer and orchestrators report `healthy` status
- Session secret persisted in SQLite so sessions survive container restarts

---

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 |
| Web framework | Express |
| Database | SQLite via `better-sqlite3` |
| Auth | `bcryptjs` + `express-session` |
| Charts | Chart.js 4 |
| File uploads | `multer` |
| CSV parsing | `csv-parse` |
| Frontend | Vanilla HTML / CSS / JS (no framework) |

---

## Getting Started

### Local (Node.js)

**Prerequisites:** Node.js 18+

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). The first visit redirects to `/setup` to create the admin account.

For auto-restart on file changes:

```bash
npm run dev
```

### Docker (recommended for homelab)

```bash
docker compose up
```

The app is available at [http://localhost:3000](http://localhost:3000). Data is persisted via bind mounts.

**Manual homelab deploy (e.g. port 3090):**

```bash
mkdir -p /home/youruser/finance-hub/data
mkdir -p /home/youruser/finance-hub/receipts

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

**Redeploy without losing data:**

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
- `/app/data` — SQLite database (`finance.db`)
- `/app/uploads/receipts` — receipt images and PDFs

> **Schema note:** New tables in `db/schema.sql` are applied automatically on startup via `CREATE TABLE IF NOT EXISTS`. Adding columns to existing tables requires a manual `ALTER TABLE` on the host database.

---

## Project Structure

```
myfinancehub/
├── server.js                 # Express API + app entry point
├── db/
│   └── schema.sql            # Database schema (auto-applied on startup)
├── public/
│   ├── index.html            # SPA shell — top nav, sidebar, bottom nav, modal
│   ├── login.html            # Sign-in page
│   ├── setup.html            # First-run admin bootstrap
│   ├── invite.html           # Invite acceptance
│   ├── manifest.json         # PWA manifest
│   ├── sw.js                 # Service worker (cache-first shell, network-only API)
│   ├── css/
│   │   └── style.css         # Dark theme, CSS variables, responsive layout
│   └── js/
│       ├── app.js            # Shared utilities, router, dashboard module
│       ├── transactions.js   # Transaction CRUD, receipt upload, payee logos
│       ├── budget.js         # Budget management
│       ├── subscriptions.js  # Subscription tracking
│       ├── reminders.js      # Bill reminders
│       ├── charts.js         # Charts page incl. spending heatmap
│       ├── yearreview.js     # Year in Review page
│       ├── rules.js          # Rules engine UI
│       └── import.js         # CSV import + export
├── scripts/
│   └── hash-password.js      # One-off bcrypt hash helper
├── data/                     # SQLite database (gitignored, created at runtime)
├── uploads/
│   └── receipts/             # Receipt files (persisted via bind mount)
├── Dockerfile
└── docker-compose.yml
```

---

## API Reference

All `/api/*` routes require an active session cookie. Admin-only routes are noted.

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Returns `{ status: "healthy" }` — used by Docker HEALTHCHECK |

### Auth & Users

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/setup` | First-run: create the initial admin user |
| POST | `/auth/login` | Log in and set session cookie |
| GET  | `/auth/logout` | Destroy session and redirect to login |
| POST | `/auth/change-password` | Change current user's password |
| POST | `/auth/invite` | Accept an invite token and create a member account |
| GET  | `/api/auth/me` | Current user `{ username, role }` |
| GET  | `/api/users` | List all users (admin) |
| DELETE | `/api/users/:id` | Remove a non-admin user (admin) |
| POST | `/api/invites` | Generate a one-time invite link — 7-day expiry (admin) |

### Transactions & Receipts

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/transactions` | List — params: `month`, `payee`, `category`, `search`, `limit`, `offset` |
| GET | `/api/transactions/:id` | Get single transaction |
| POST | `/api/transactions` | Create (rules auto-applied) |
| PUT | `/api/transactions/:id` | Update |
| DELETE | `/api/transactions/:id` | Delete (also removes attached receipt file) |
| GET | `/api/transactions/summary` | `{ income, expenses, net }` for a month |
| POST | `/api/transactions/:id/receipt` | Upload receipt (JPG/PNG/WEBP/PDF, ≤10 MB) |
| DELETE | `/api/transactions/:id/receipt` | Remove attached receipt |

### Budgets & Categories

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/budgets` | List monthly budgets |
| GET | `/api/budgets/status` | Spent vs budget per category for a month |
| POST | `/api/budgets` | Create or update a budget (upsert) |
| DELETE | `/api/budgets/:id` | Remove a budget |
| GET | `/api/categories` | List categories |
| POST | `/api/categories` | Add a category |
| DELETE | `/api/categories/:name` | Remove a category |
| GET | `/api/payees` | Distinct payee name suggestions |

### Subscriptions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/subscriptions` | List — `?active=1` for active only |
| GET | `/api/subscriptions/detect` | Suggest subscriptions from transaction history |
| GET | `/api/subscriptions/:id` | Get one |
| POST | `/api/subscriptions` | Create |
| PUT | `/api/subscriptions/:id` | Update |
| DELETE | `/api/subscriptions/:id` | Delete |
| POST | `/api/subscriptions/:id/pay` | Mark paid — advances `next_due_date` and creates a transaction |

### Reminders

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/reminders` | List — params: `paid`, `upcoming_days` |
| GET | `/api/reminders/detect` | Suggest recurring bills from transaction history |
| GET | `/api/reminders/:id` | Get one |
| POST | `/api/reminders` | Create |
| PUT | `/api/reminders/:id` | Update |
| DELETE | `/api/reminders/:id` | Delete |
| POST | `/api/reminders/:id/pay` | Mark paid — rolls recurring due date and creates a transaction |

### Charts & Analytics

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/charts/category-breakdown` | Spending by category for a month |
| GET | `/api/charts/category-monthly` | Per-category spending over N months (for sparklines) |
| GET | `/api/charts/monthly-by-payee` | Spending by payee for a month |
| GET | `/api/charts/spending-trend` | Income vs expenses over N months |
| GET | `/api/charts/spending-heatmap` | Daily expense totals for a year — `?year=YYYY` |
| GET | `/api/charts/available-months` | Months with transaction data (for pickers) |
| GET | `/api/year-review/:year` | Aggregated year-end stats, monthly breakdown, top expenses |

### Rules Engine

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/rules` | List rules (ordered by priority DESC) |
| POST | `/api/rules` | Create a rule |
| PUT | `/api/rules/:id` | Update or toggle a rule |
| DELETE | `/api/rules/:id` | Delete a rule |
| POST | `/api/rules/apply` | Bulk-apply all enabled rules to existing transactions |

### Import / Export

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/import/csv` | Upload and import a CSV file (rules auto-applied per row) |
| GET | `/api/export/csv` | Download all transactions as CSV |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port the server listens on |
| `SESSION_SECRET` | random per boot | Signs session cookies. Set a fixed value in production so sessions survive container restarts. |
| `NODE_ENV` | — | Set to `production` in the Docker image |

---

## Screenshots

<img width="1581" height="878" alt="Screenshot 2026-04-05 at 11 04 11 AM" src="https://github.com/user-attachments/assets/99bece77-4216-437b-b9ce-fb9744137dd3" />
<img width="1623" height="877" alt="Screenshot 2026-04-05 at 11 05 16 AM" src="https://github.com/user-attachments/assets/cd1bffed-0e95-47b5-8d6e-f6b3a4a74fba" />
<img width="1594" height="872" alt="Screenshot 2026-04-05 at 11 05 32 AM" src="https://github.com/user-attachments/assets/6153274c-f8a0-4516-bde8-e8f7e1b88fc9" />
<img width="479" height="580" alt="Screenshot 2026-04-05 at 11 05 51 AM" src="https://github.com/user-attachments/assets/c26cf836-472d-4833-89f9-b50950127461" />
