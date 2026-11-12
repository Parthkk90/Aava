# syntax=docker/dockerfile:1.7
# Multi-target image for the Aava workspace.
#   docker build -f infra/Dockerfile --target relay .
#   docker build -f infra/Dockerfile --target web .
FROM node:22.12-alpine AS workspace
# (corepack in this Node image ships outdated registry signing keys; install pnpm directly)
RUN npm install -g pnpm@9.15.9
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile

# Reference relay (operator software). Any NIP-01 relay can replace it.
FROM workspace AS relay
ENV RELAY_HOST=0.0.0.0 RELAY_PORT=7001 RELAY_DATA_FILE=/data/events.jsonl
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 7001
CMD ["pnpm", "--filter", "@relaymesh/relay", "start"]

# Tooling image: demo setup / headless demo / merchant.
FROM workspace AS tools
USER node

# Static frontend build. Relay and RPC defaults are build-time settings only;
# users can change everything in the app.
FROM workspace AS web-build
# Empty = the public default relays in apps/web/src/runtime/settings.ts.
ARG VITE_DEFAULT_RELAYS=
ARG VITE_LOCAL_RPC_URL=http://127.0.0.1:8545
ARG VITE_DEFAULT_CHAIN_ID=11155111
ARG VITE_ALLOW_REMOTE_DEVNET_WALLET=0
ENV VITE_DEFAULT_RELAYS=$VITE_DEFAULT_RELAYS VITE_LOCAL_RPC_URL=$VITE_LOCAL_RPC_URL VITE_DEFAULT_CHAIN_ID=$VITE_DEFAULT_CHAIN_ID VITE_ALLOW_REMOTE_DEVNET_WALLET=$VITE_ALLOW_REMOTE_DEVNET_WALLET
RUN pnpm --filter @relaymesh/web build

FROM nginx:1.27-alpine AS web
COPY infra/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
