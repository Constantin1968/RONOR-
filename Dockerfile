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

# Construire reproductibilă: lockfile-ul comis decide versiunile exacte.
# `npm ci` refuză să ruleze dacă package.json și package-lock.json nu se
# potrivesc și nu rezolvă din nou intervalele `^` (reconstrucția primarei,
# 25.09.2026: `npm install` fără lockfile a dat 3 pachete cu altă versiune).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

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

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && \
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

# Opt-in development control process. Does not replace the main runtime.
FROM runtime AS development-controller
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && chown -R 10001:10001 /app/data
USER 10001:10001
ENV RONOR_DEVELOPMENT_HOST=0.0.0.0
ENV RONOR_DEVELOPMENT_PORT=3010
EXPOSE 3010
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:3010/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "dist/runtime/automation/services/development-controller-server.js"]

# Preserve the original default image for callers that do not specify --target.
FROM runtime AS default-runtime
