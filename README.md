# MyFinanceHub

A self-hosted personal finance tracker. Import transactions via CSV, categorize spending, and view summaries — all running locally with no cloud dependency.

## Stack

- **Backend**: Node.js + Express
- **Database**: SQLite (via `better-sqlite3`)
- **Frontend**: Vanilla HTML/CSS/JS (served as static files)
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

### Docker

```bash
docker compose up
```

The app will be available at [http://localhost:3000](http://localhost:3000). The SQLite database is persisted via a Docker volume.

## Project Structure

```
myfinancehub/
├── server.js          # Express API + app entry point
├── db/
│   └── schema.sql     # Database schema (auto-applied on startup)
├── public/            # Frontend (HTML, CSS, JS)
│   ├── index.html
│   ├── css/
│   └── js/
├── data/              # SQLite database (gitignored, created at runtime)
├── uploads/           # Temporary CSV upload staging (gitignored)
├── Dockerfile
└── docker-compose.yml
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/transactions` | List transactions (supports `month`, `payee`, `category`, `search`, `limit`, `offset`) |
| POST | `/api/transactions/import` | Upload and import a CSV file |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port the server listens on |
