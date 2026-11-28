# syntax=docker/dockerfile:1
#
# The swarm's one image. The role is the argument: gateway | worker | migrate.
#
#   docker build -f examples/swarm/Dockerfile -t agent-swarm .     # context = the monorepo root
#   docker run --rm agent-swarm migrate
#   docker run --rm -p 8080:8080 agent-swarm gateway
#   docker run --rm agent-swarm worker
#
# No secret is baked in: provider keys, the gateway's tokens and the database URL come from the
# environment (or *_FILE) at run time. Runs as `node` (uid 1000) and needs no writable root
# filesystem - only a writable /tmp (the agent's per-run sandbox directory): `--read-only
# --tmpfs /tmp`.
#
# glibc (bookworm), not Alpine: Temporal's core bridge is a native module built for glibc.

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
# pnpm in the version package.json's `packageManager` names.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm --version
# The manifests of the projects the swarm needs, then the install: this layer stays cached until a
# dependency changes. (@dudko.dev/test-servers is the agent's dev dependency.)
COPY packages/agent/package.json packages/agent/
COPY packages/test-servers/package.json packages/test-servers/
COPY examples/swarm/package.json examples/swarm/
RUN pnpm install --frozen-lockfile --filter "swarm..."
# The sources: the agent is built from this tree (workspace:*), then the workflow bundle.
COPY packages/agent packages/agent
COPY examples/swarm examples/swarm
RUN pnpm --filter @dudko.dev/agent build && pnpm --filter swarm build
# A pruned production install of the swarm alone - its files, its production dependencies, the
# agent's dist - resolved from the workspace lockfile. `deploy` copies workspace packages
# (injected); the repo keeps them linked for development, so the setting is given here only.
RUN pnpm --filter swarm deploy --prod --config.inject-workspace-packages=true /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production TMPDIR=/tmp
WORKDIR /app
# Owned by root, read by `node`: the process cannot change its own code.
COPY --from=build /out /app
USER node
# gateway: 8080 (GATEWAY_PORT); worker: 8081 (WORKER_HEALTH_PORT, /healthz and /readyz).
EXPOSE 8080 8081
ENTRYPOINT ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "/app/src/main.ts"]
