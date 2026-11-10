# syntax=docker/dockerfile:1
# Build context is the repository root (pnpm workspace).
FROM node:22-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@10.28.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile --filter @share-anywhere/web...
COPY web web
RUN pnpm --filter @share-anywhere/web build

FROM caddy:2-alpine
COPY web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/web/dist /srv
RUN find /srv -name '*.map' -delete
EXPOSE 80
