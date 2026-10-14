FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS base
WORKDIR /app
RUN npm install --global pnpm@10.22.0 tsx@4.23.15

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:web

FROM base AS api
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --prod --frozen-lockfile --filter @sandbox/server...
COPY apps/server/src apps/server/src
COPY packages packages
COPY scripts/deploy scripts/deploy
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
CMD ["tsx", "apps/server/src/main.ts"]

FROM caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f AS web
COPY --from=build /app/apps/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile

FROM postgres:18.4@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636 AS operations
WORKDIR /app
COPY --from=api /usr/local/bin/node /usr/local/bin/node
COPY --from=api /usr/local/lib/node_modules/tsx /usr/local/lib/node_modules/tsx
COPY --from=api /app /app
ENTRYPOINT ["node", "/usr/local/lib/node_modules/tsx/dist/cli.mjs"]
CMD ["apps/server/src/operations/restore.ts"]
