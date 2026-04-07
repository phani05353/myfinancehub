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
# Create persistent directories on the host first
mkdir -p /home/youruser/finance-hub/data
mkdir -p /home/youruser/finance-hub/receipts

# Build and run
docker build -t home-finance .
docker run -d \
  --name home-finance \
  --restart unless-stopped \
  -p 3090:3000 \
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
<img width="1623" height="877" alt="Screenshot 2026-04-05 at 11 05 16 AM" src="https://github.com/user-attachments/assets/cd1bffed-0e95-47b5-8d6e-f6b3a4a74fba" />
<img width="1594" height="872" alt="Screenshot 2026-04-05 at 11 05 32 AM" src="https://github.com/user-attachments/assets/6153274c-f8a0-4516-bde8-e8f7e1b88fc9" />
<img width="479" height="580" alt="Screenshot 2026-04-05 at 11 05 51 AM" src="https://github.com/user-attachments/assets/c26cf836-472d-4833-89f9-b50950127461" />

