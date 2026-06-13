# ─────────────────────────────────────────────────────────────────────────────
# Home Finance — self-hosted personal finance tracker
#
# Build:
#   docker build -t home-finance .
#
# Run:
#   docker run -d \
#     --name home-finance \
#     --restart unless-stopped \
#     -p 3000:3000 \
#     -v /your/data/path:/app/data \
#     home-finance
#
# Then open http://your-homelab-ip:3000
# All data lives in /your/data/path/finance.db — back that up.
#
# Base image is Debian slim (not Alpine) because @temporalio/worker ships
# prebuilt binaries for glibc only.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-slim

# Build deps for better-sqlite3 native bindings + ca-certs for outbound HTTPS
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Enable pnpm via corepack (version pinned by package.json "packageManager").
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Install dependencies first (layer cached unless the manifest/lockfile change).
# pnpm-workspace.yaml carries onlyBuiltDependencies so the native deps
# (better-sqlite3, @swc/core) are actually compiled rather than skipped.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Drop the build toolchain to keep the runtime image leaner
RUN apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY . .

# Data dir is the only thing that needs to persist between container restarts
RUN mkdir -p data uploads

VOLUME ["/app/data"]

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
