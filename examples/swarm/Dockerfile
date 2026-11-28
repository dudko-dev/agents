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
# The runtime is distroless (glibc, no shell, no package manager): Node's binary from the official
# image, and the app. glibc, not Alpine: Temporal's core bridge is a native module built for glibc.
# Built for the platform it runs on (buildx --platform): the install keeps that platform's native
# binaries only (scripts/prune-image.ts).

ARG NODE_IMAGE=node:24-bookworm-slim
# Debian 12 (the glibc of node:*-bookworm), with libgcc and libstdc++ (what node needs).
ARG RUNTIME_IMAGE=gcr.io/distroless/cc-debian12:nonroot

FROM ${NODE_IMAGE} AS build
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
# pnpm in the version package.json's `packageManager` names.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm --version
# The manifests of the projects the swarm needs, then the install: this layer stays cached until a
# dependency changes. (@dudko.dev/test-servers is the agent's dev dependency; swarm-shared is the
# swarm's platform-independent part.)
COPY packages/agent/package.json packages/agent/
COPY packages/test-servers/package.json packages/test-servers/
COPY examples/swarm-shared/package.json examples/swarm-shared/
COPY examples/swarm/package.json examples/swarm/
RUN pnpm install --frozen-lockfile --filter "swarm..."
# The sources: the agent and swarm-shared are built from this tree (workspace:*; swarm-shared ships
# JS - node_modules gets a copy of it below, and Node strips no types there), then the workflow
# bundle.
COPY packages/agent packages/agent
COPY examples/swarm-shared examples/swarm-shared
COPY examples/swarm examples/swarm
RUN pnpm --filter @dudko.dev/agent build && pnpm --filter swarm-shared build \
  && pnpm --filter swarm build
# A pruned production install of the swarm alone - its files, its production dependencies, the
# agent's and swarm-shared's dist - resolved from the workspace lockfile. `deploy` copies workspace packages
# (injected); the repo keeps them linked for development, so the setting is given here only.
# Then what the roles never load: the workflow bundler (the bundle is prebuilt), the core bridge's
# binaries of other platforms, declarations and source maps.
RUN pnpm --filter swarm deploy --prod --config.inject-workspace-packages=true /out \
  && node --experimental-strip-types --disable-warning=ExperimentalWarning \
    examples/swarm/scripts/prune-image.ts /out
# The runtime's user: `node`, uid 1000 (as in the official image), with no shell.
RUN mkdir -p /rootfs/etc \
  && printf 'root:x:0:0:root:/root:/sbin/nologin\nnobody:x:65534:65534:nobody:/nonexistent:/sbin/nologin\nnode:x:1000:1000:node:/home/node:/sbin/nologin\n' > /rootfs/etc/passwd \
  && printf 'root:x:0:\nnogroup:x:65534:\nnode:x:1000:\n' > /rootfs/etc/group

FROM ${NODE_IMAGE} AS node

FROM ${RUNTIME_IMAGE} AS runtime
ENV NODE_ENV=production TMPDIR=/tmp HOME=/tmp
COPY --from=build /rootfs/etc/passwd /rootfs/etc/group /etc/
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
# Owned by root, read by `node`: the process cannot change its own code.
COPY --from=build /out /app
USER 1000:1000
# gateway: 8080 (GATEWAY_PORT); worker: 8081 (WORKER_HEALTH_PORT, /healthz and /readyz).
EXPOSE 8080 8081
ENTRYPOINT ["/usr/local/bin/node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "/app/src/main.ts"]
