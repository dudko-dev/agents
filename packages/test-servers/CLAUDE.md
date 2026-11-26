# @dudko.dev/test-servers — instructions for Claude

> Lives in the `dudko-dev/agents` monorepo at `packages/test-servers`. The root `CLAUDE.md` has the
> workspace commands (pnpm + nx) and the rules shared by all packages; this file is about this
> package only.

The servers the other packages' tests run against: a test enterprise identity provider, a test MCP
authorization server and a test MCP server. Real sockets, real signatures, the MCP SDK's own server
implementation. `"private": true` — **never published**, never a runtime dependency of anything.

## Principles

- **For tests only, loopback only.** `listen` (`src/http.ts`) refuses every host but `127.0.0.1` and
  `::1`, and the CLI refuses the same before it starts anything. That guard is a security boundary:
  these servers issue tokens freely and have switches that make them lie. A change to it needs a
  test (`tests/cors-loopback.test.ts`, `tests/cli.test.ts`) and a mutation check. Never add a way
  around it ("just for CI", a `0.0.0.0` flag, `localhost`).
- **No secrets, ever.** Keys and client secrets are generated at start-up and die with the
  process. Nothing is read from the environment or from disk; no fixture holds a key.
- **A server here must be a faithful peer, strict where the specification is.** A check a real
  server would make stays in (signature, `typ`, `iss`, `aud`, `exp`, `jti` replay, the client the
  grant was issued to). A test that passes against a lax server proves nothing.
- **Misbehaviour is a switch, off by default, one thing at a time** (`idp.misbehave`, `as.faults`,
  `assertionProfile`, ...). A new one goes in the README table and gets its own test.
- **No build.** Source is TypeScript run by Node's type stripping, like the Node package's tests:
  `.ts` extensions in relative imports, no enums, no parameter properties, no path aliases.
  `package.json` `exports` points at `src/index.ts`; the packages that use it declare
  `"@dudko.dev/test-servers": "workspace:*"` in `devDependencies` (pnpm does not hoist). It works
  from another package because pnpm's link resolves to the real path, which is outside
  `node_modules` — Node will not strip types inside `node_modules`.

## Layout

- `src/http.ts` — binding (`listen`, `assertLoopbackHost`), CORS (`corsHeaders`, `applyCors`), and
  the plain `node:http` helpers. The CORS header set mirrors the browser package's README ("CORS")
  and `packages/agent-web-react/e2e/servers.ts`: change them together.
- `src/jwt.ts` — sign / verify (`node:crypto`), `verifyClientAssertion` with its two profiles
  (`'rfc7523bis'`: `aud` = issuer, `typ: client-authentication+jwt`; `'rfc7523'`: `aud` = token
  endpoint, `typ: JWT`), `generateClientKey`, `readClientAuth`, the grant and token-type constants.
- `src/idp-server.ts` — `startLocalIdp`: ID tokens, JWKS, the RFC 8693 token exchange → ID-JAG.
- `src/authorization-server.ts` — `startLocalAuthorizationServer`: metadata, registration, token
  endpoint; with `enterprise`, the `jwt-bearer` grant only (ID-JAG draft, section 4.4.1, in order).
- `src/mcp-server.ts` — `startLocalMcpServer` (the SDK's stateless streamable-HTTP server, tools
  `echo` / `secret` / `boom`; options add `instructions` and the structured tools `report` /
  `report_mixed`, whose switch is `structuredFaults`) and `startLocalMcp`, the pair with its authorization server that most
  tests use.
- `src/cli.ts` — `parseCliArgs`, `startFromCli`, and the entry that prints one JSON line.
- `src/index.ts` — exports only.
- `tests/` — `node:test` suites, one per server, plus CORS / loopback and the CLI (which is also
  spawned as a process). `tests/helpers.ts` signs assertions by hand, so the servers are checked
  against something other than the providers they are later used to test.

## Commands

```bash
pnpm nx run-many -t typecheck format:check test -p @dudko.dev/test-servers
```

There is no `build` target. `packages/agent` and `packages/agent-web` import this source in their
tests: after a change here, run their checks too (`pnpm affected`, or `pnpm check`).

## Conventions

- Prettier: no semicolons, single quotes, trailing commas, width 100.
- An option or a switch added to a server is documented in `README.md` in the same change.
- Keep `ILocalMcp` / `ILocalIdp` stable: several suites in other packages read their fields.
- The CLI prints exactly one line on stdout. Anything else goes to stderr.

## Boundaries

- Never remove `"private": true`, add `publishConfig`, or add this directory to
  `.github/scripts/release-plan.mjs` (`DIRS`): that script throws on a private package by design.
- The weekly autoupdate updates this package's dependencies like any other and, because it is
  private, never bumps its version or writes a changelog for it.
