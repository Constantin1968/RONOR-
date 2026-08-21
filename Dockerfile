# RONOR — Governed Intelligence for Energy Operations
# Multi-stage Dockerfile. Debian-slim base (better-sqlite3 needs glibc, not musl).

# ============================================================
# Stage 1 — build
# ============================================================
FROM node:20-bookworm-slim AS build

WORKDIR /app

# System deps for better-sqlite3 native build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts

RUN npm run build

# ============================================================
# Stage 2 — runtime
# ============================================================
FROM node:20-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Runtime system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && \
    npm cache clean --force

# Copy built artefacts and static assets
COPY --from=build /app/dist ./dist
COPY --from=build /app/web ./web
COPY src/governance/policies.yaml ./src/governance/policies.yaml

# Audit chain persistence
RUN mkdir -p /app/data
VOLUME ["/app/data"]
ENV AUDIT_DB_PATH=/app/data/audit.db
ENV MI9_POLICY_PATH=/app/src/governance/policies.yaml

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/index.js"]
