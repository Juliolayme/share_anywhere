# syntax=docker/dockerfile:1
# Build context is the repository root (pnpm workspace).
FROM node:22-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@10.28.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile --filter @share-anywhere/web...
COPY shared/i18n shared/i18n
# Shared transfer state table, read by the runtime tests that `tsc -b` type-checks.
COPY shared/protocol/schemas shared/protocol/schemas
COPY web web
# Test stacks only: exposes engine counters and fault injection (docs/TESTING_AND_CI.md §3). Off by default.
ARG VITE_TEST_HOOKS=false
ENV VITE_TEST_HOOKS=$VITE_TEST_HOOKS
# Sender block cache budget in MiB (docs/TRANSFER_PROTOCOL.md §5.1).
ARG VITE_BLOCK_CACHE_MB=64
ENV VITE_BLOCK_CACHE_MB=$VITE_BLOCK_CACHE_MB
RUN pnpm --filter @share-anywhere/web build

FROM caddy:2-alpine
COPY web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/web/dist /srv
RUN find /srv -name '*.map' -delete \
 && addgroup -S web && adduser -S -G web -H -s /sbin/nologin web \
 && mkdir -p /data /config && chown -R web:web /data /config
USER web
EXPOSE 8080
