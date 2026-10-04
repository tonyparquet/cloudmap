# Image unique pour tous les clients : aucune donnée client n'y est incluse (tout passe par
# CONFIG_DIR, DATA_DIR et les secrets Docker). Construction depuis la racine du dépôt :
#   docker build -f deploy/Dockerfile -t cartographe-aws .
ARG NODE_IMAGE=node:22-alpine

# ---------------------------------------------------------------- construction
FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

# ---------------------------------------------------------------- dépendances natives d'exécution
# Le serveur et la CLI sont bundlés : seuls better-sqlite3 et argon2 (prébuilds musl) restent externes.
FROM ${NODE_IMAGE} AS runtime-deps
WORKDIR /app
COPY deploy/runtime/package.json deploy/runtime/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---------------------------------------------------------------- image finale minimale, non-root
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=8443 \
    APP_ROOT=/app \
    CONFIG_DIR=/config \
    DATA_DIR=/data
WORKDIR /app
RUN addgroup -S -g 10001 carto \
 && adduser -S -D -H -u 10001 -G carto -s /sbin/nologin carto \
 && mkdir -p /config /data \
 && chown 10001:10001 /config /data \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /src/apps/server/dist/main.mjs ./apps/server/dist/main.mjs
COPY --from=build /src/apps/cli/dist/main.mjs ./apps/cli/dist/main.mjs
COPY --from=build /src/apps/web/dist ./apps/web/dist
COPY config ./config
COPY fixtures ./fixtures
COPY docs/iam ./docs/iam
COPY docs/azure ./docs/azure
COPY CHANGELOG.md ./CHANGELOG.md
USER 10001:10001
EXPOSE 8443
VOLUME ["/config", "/data"]
# Healthcheck en HTTPS (TLS 1.3) sur /healthz, qui ne révèle aucune information.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "require('https').get({host:'127.0.0.1',port:process.env.PORT||8443,path:'/healthz',minVersion:'TLSv1.3',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
ENTRYPOINT ["node", "apps/server/dist/main.mjs"]
