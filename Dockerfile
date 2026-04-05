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
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-alpine

# Build deps for better-sqlite3 native bindings
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies first (layer cached unless package.json changes)
COPY package*.json ./
RUN npm install --omit=dev

# Remove build deps after native modules are compiled (keeps image slim)
RUN apk del python3 make g++ && rm -rf /var/cache/apk/*

COPY . .

# Data dir is the only thing that needs to persist between container restarts
RUN mkdir -p data uploads

VOLUME ["/app/data"]

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "server.js"]
