# syntax=docker/dockerfile:1.7
# Debian slim — Prisma's schema-engine binary needs glibc + OpenSSL detection
# which is flaky on Alpine/musl.
FROM node:20-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates openssl curl \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/control-plane/package.json packages/control-plane/
# `--shamefully-hoist` flattens node_modules so bin shims aren't symlinks
# into pnpm's content-addressed store — avoids EACCES on Podman/userns hosts.
RUN pnpm install --frozen-lockfile=false --shamefully-hoist

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/control-plane packages/control-plane
RUN pnpm --filter @labforge/shared build
RUN pnpm --filter @labforge/control-plane exec prisma generate
RUN pnpm --filter @labforge/control-plane build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages /app/packages
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
WORKDIR /app/packages/control-plane
EXPOSE 4000
CMD ["node", "dist/server.js"]
