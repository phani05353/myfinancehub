# MyFinanceHub

A self-hosted personal finance tracker. Import transactions via CSV, manually log income and expenses, track subscriptions, set bill reminders, and visualize spending — all running locally with no cloud dependency.

## Features

- **Dashboard** — monthly income/expense summary, savings rate bar, top spending categories, recent transactions, and a 6-month trend chart
- **Transactions** — add/edit/delete with an Expense / Income toggle (no manual sign entry), filter by month, category, or keyword
- **Subscriptions** — track recurring charges, auto-detect from transaction history
- **Bill Reminders** — due-date tracking with overdue alerts in the sidebar
- **Charts** — spending by payee, category breakdown donut, income vs expense trend
- **CSV Import** — drag-and-drop import with duplicate detection

## Stack

- **Backend**: Node.js + Express
- **Database**: SQLite (via `better-sqlite3`)
- **Frontend**: Vanilla HTML/CSS/JS (served as static files), Chart.js
- **CSV Import**: `csv-parse`
- **File Uploads**: `multer`

## Getting Started

### Local (Node.js)

**Prerequisites:** Node.js 18+

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

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
# Create data directory on the host first
mkdir -p /home/youruser/finance-hub/data

# Build and run
docker build -t home-finance .
docker run -d \
  --name home-finance \
  --restart unless-stopped \
  -p 3090:3000 \
  -v /home/youruser/finance-hub/data:/app/data \
  home-finance
```

**Redeploy without losing data:**

```bash
docker stop home-finance && docker rm home-finance
docker build -t home-finance .
docker run -d --name home-finance --restart unless-stopped \
  -p 3090:3000 \
  -v /home/youruser/finance-hub/data:/app/data \
  home-finance
```

Data lives in `finance.db` on the host — it is never touched during a rebuild.

> **Schema note:** Adding new tables to `db/schema.sql` is safe (applied automatically on startup). Adding columns to *existing* tables requires a manual `ALTER TABLE` migration on the host database.

## Project Structure

```
myfinancehub/
├── server.js              # Express API + app entry point
├── db/
│   └── schema.sql         # Database schema (auto-applied on startup)
├── public/
│   ├── index.html
│   ├── css/style.css      # Dark theme, mobile-responsive
│   └── js/
│       ├── app.js         # Shared utils, router, dashboard
│       ├── transactions.js
│       ├── subscriptions.js
│       ├── reminders.js
│       ├── charts.js
│       └── import.js
├── data/                  # SQLite database (gitignored, created at runtime)
├── uploads/               # Temporary CSV upload staging (gitignored)
├── Dockerfile
└── docker-compose.yml
```

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/transactions` | List transactions (`month`, `payee`, `category`, `search`, `limit`, `offset`) |
| GET | `/api/transactions/:id` | Get single transaction |
| POST | `/api/transactions` | Create transaction |
| PUT | `/api/transactions/:id` | Update transaction |
| DELETE | `/api/transactions/:id` | Delete transaction |
| GET | `/api/transactions/summary` | Income / expenses / net for a month |
| GET | `/api/subscriptions` | List subscriptions |
| GET | `/api/reminders` | List bill reminders |
| GET | `/api/charts/category-breakdown` | Spending by category for a month |
| GET | `/api/charts/monthly-by-payee` | Spending by payee for a month |
| GET | `/api/charts/spending-trend` | Income vs expenses over N months |
| POST | `/api/import/csv` | Upload and import a CSV file |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port the server listens on |
| `NODE_ENV` | — | Set to `production` in Docker |

## Screenshots
<img width="1581" height="878" alt="Screenshot 2026-04-05 at 11 04 11 AM" src="https://github.com/user-attachments/assets/99bece77-4216-437b-b9ce-fb9744137dd3" />

<img width="1587" height="886" alt="Screenshot 2026-04-05 at 11 03 06 AM" src="https://github.com/user-attachments/assets/ea27ffc8-56b1-4d36-87a2-6f04192c88b7" />



