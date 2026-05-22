# syntax=docker/dockerfile:1.7
# Next.js 15 production build — admin UI for LabForge.
FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/admin-ui/package.json packages/admin-ui/
RUN pnpm install --frozen-lockfile=false --shamefully-hoist

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/admin-ui packages/admin-ui
RUN pnpm --filter @labforge/shared build
RUN pnpm --filter @labforge/admin-ui build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages /app/packages
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
WORKDIR /app/packages/admin-ui
EXPOSE 4100
CMD ["pnpm", "start"]
