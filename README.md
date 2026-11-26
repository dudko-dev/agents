# agents

Monorepo of the `@dudko.dev` agent packages: a tool-using planning agent for Node, the same loop
running fully in the browser, React bindings for it, and a demo.

| Path | Package | What it is |
| --- | --- | --- |
| [`packages/agent`](packages/agent) | [`@dudko.dev/agent`](https://www.npmjs.com/package/@dudko.dev/agent) | Node / server: plan → execute → replan → synthesize over MCP servers, a REPL CLI, persistence and resume, OpenTelemetry. |
| [`packages/agent-web`](packages/agent-web) | [`@dudko.dev/agent-web`](https://www.npmjs.com/package/@dudko.dev/agent-web) | The same loop in the browser: BYOK cloud providers or local WebGPU models, an encrypted key vault, HTTP MCP. |
| [`packages/agent-web-react`](packages/agent-web-react) | [`@dudko.dev/agent-web-react`](https://www.npmjs.com/package/@dudko.dev/agent-web-react) | React bindings: the `useAgent` hook, a provider and a drop-in chat. |
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

## History

The three packages were separate repositories (`dudko-dev/agent`, `dudko-dev/agent-web`,
`dudko-dev/agent-web-react`); their histories were merged in. To follow a file past the move:
`git log --follow -- packages/agent/src/runner.ts`.

## License

MIT © Siarhei Dudko
