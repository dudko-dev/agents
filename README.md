# agents

[![CI](https://github.com/dudko-dev/agents/actions/workflows/ci.yml/badge.svg)](https://github.com/dudko-dev/agents/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/dudko-dev/agents.svg)](LICENSE)
[![last commit](https://img.shields.io/github/last-commit/dudko-dev/agents.svg)](https://github.com/dudko-dev/agents/commits/main)

Monorepo of the `@dudko.dev` agent packages: a tool-using planning agent for Node, the same loop
running fully in the browser, React bindings for it, and a demo.

| Path | Package | What it is |
| --- | --- | --- |
| [`packages/agent`](packages/agent) | [`@dudko.dev/agent`](https://www.npmjs.com/package/@dudko.dev/agent)<br>[![npm](https://img.shields.io/npm/v/@dudko.dev/agent.svg)](https://www.npmjs.com/package/@dudko.dev/agent) [![downloads](https://img.shields.io/npm/dy/@dudko.dev/agent.svg)](https://www.npmjs.com/package/@dudko.dev/agent) | Node / server: plan → execute → replan → synthesize over MCP servers, a REPL CLI, persistence and resume, OpenTelemetry. |
| [`packages/agent-web`](packages/agent-web) | [`@dudko.dev/agent-web`](https://www.npmjs.com/package/@dudko.dev/agent-web)<br>[![npm](https://img.shields.io/npm/v/@dudko.dev/agent-web.svg)](https://www.npmjs.com/package/@dudko.dev/agent-web) [![downloads](https://img.shields.io/npm/dy/@dudko.dev/agent-web.svg)](https://www.npmjs.com/package/@dudko.dev/agent-web) | The same loop in the browser: BYOK cloud providers or local WebGPU models, an encrypted key vault, HTTP MCP. |
| [`packages/agent-web-react`](packages/agent-web-react) | [`@dudko.dev/agent-web-react`](https://www.npmjs.com/package/@dudko.dev/agent-web-react)<br>[![npm](https://img.shields.io/npm/v/@dudko.dev/agent-web-react.svg)](https://www.npmjs.com/package/@dudko.dev/agent-web-react) [![downloads](https://img.shields.io/npm/dy/@dudko.dev/agent-web-react.svg)](https://www.npmjs.com/package/@dudko.dev/agent-web-react) | React bindings: the `useAgent` hook, a provider and a drop-in chat. |
| [`apps/demo`](apps/demo) | — (private) | The Vite demo of the React package ([live](https://agent.dudko.dev/demo/)). |

Each package keeps its own README, docs and version; they are published to npm independently.

## Working in the repo

Needs Node ≥ 22.6 and [pnpm](https://pnpm.io) 10 (`corepack enable`). Tasks run through
[Nx](https://nx.dev), which orders them by the dependency graph (a package's `dist` is built
before what consumes it) and caches the results.

```bash
pnpm install

pnpm check                 # typecheck, format:check, build and test for everything
pnpm affected              # the same, only for what changed against main
pnpm test:e2e              # the browser tests (Playwright over the built demo)

pnpm nx test @dudko.dev/agent-web          # one target of one package
pnpm nx run-many -t build -p demo          # the demo and everything it needs
pnpm --filter demo dev                     # the demo's dev server (build the library first)
pnpm --filter @dudko.dev/agent start       # the Node agent's REPL from source
```

Packages depend on each other through `workspace:*`, so a change in the core is tested against
the React package and the demo in the same pull request.

## Releasing

Bump `version` in the `package.json` of the package(s) to publish, in a pull request of its own.
When CI has passed on `main`, the Release workflow publishes every package whose version is not on
npm yet (npm Trusted Publishing, with provenance), tags it `<package-dir>-v<version>` and creates a
GitHub release. The Node agent is published only after a smoke test against a real model.
`node .github/scripts/release-plan.mjs --human` shows what the next run would publish.

## History

The three packages were separate repositories (`dudko-dev/agent`, `dudko-dev/agent-web`,
`dudko-dev/agent-web-react`); their histories were merged in. To follow a file past the move:
`git log --follow -- packages/agent/src/runner.ts`.

## License

MIT © Siarhei Dudko
