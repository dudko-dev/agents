# @dudko.dev/test-servers

Test servers for the agent packages in this repository: an enterprise identity provider, an MCP
authorization server and an MCP server. Real sockets, real signatures, the MCP SDK's own server —
and switches that make each of them misbehave on purpose.

**Private. Never published. For tests only.** These servers hand a token to anyone who asks the
right way, generate their keys and secrets at start-up, keep nothing, and can be told to lie. They
bind to loopback (`127.0.0.1` or `::1`) and refuse anything else. Do not put one behind a tunnel,
a proxy or a container port mapping, and do not point anything but a test at one.

TypeScript run directly by Node (type stripping, Node ≥ 22.6); there is no build step.

## The servers

| Server | Start | What it does |
| --- | --- | --- |
| Identity provider | `startLocalIdp(opts)` | Issues signed ID tokens for a test user, serves its JWKS, and answers the RFC 8693 token exchange with a signed ID-JAG (draft-ietf-oauth-identity-assertion-authz-grant) after authenticating the client. |
| Authorization server | `startLocalAuthorizationServer(opts)` | Metadata (RFC 8414), dynamic registration and a token endpoint that rotates the access token. With `enterprise`: only the `jwt-bearer` grant with an ID-JAG from one IdP, verified claim by claim. |
| MCP server | `startLocalMcpServer(opts)` | The MCP SDK's streamable-HTTP server with three tools (`echo`, `secret`, `boom`), optional `instructions` in its `initialize` result (`mcp.setInstructions()` changes them for the next client to connect), optional structured tools (`structuredTools`: `report` and `report_mixed` declare an `outputSchema` and answer with `structuredContent`), protected resource metadata (RFC 9728) and, with `requireAuth`, the 401 challenge. |
| The pair | `startLocalMcp(opts)` | An MCP server and the authorization server that guards it, on two ports, already wired together. What most tests want. |

Every one returns its URLs, what it recorded, and `close()`.

## From a test

Add the package to the `devDependencies` of the package whose tests use it (pnpm does not hoist):

```json
"@dudko.dev/test-servers": "workspace:*"
```

```ts
import { startLocalIdp, startLocalMcp } from '@dudko.dev/test-servers'

const idp = await startLocalIdp({
  clientId: 'agent-at-idp',
  clientSecret: 'made-up-for-this-test',
  resourceClientId: 'agent-at-as', // the ID-JAG's client_id claim
})
const mcp = await startLocalMcp({
  requireAuth: true,
  enterprise: {
    idpIssuer: idp.issuer,
    jwksUri: idp.jwksUri,
    clientId: 'agent-at-as',
    clientSecret: 'another-made-up-one',
  },
})
try {
  // mcp.url, mcp.issuer, mcp.tokenEndpoint, idp.tokenEndpoint, idp.issueIdToken() ...
  // afterwards: idp.exchanges, idp.issuedIdJags, mcp.tokenRequests(), mcp.calls
} finally {
  await mcp.close()
  await idp.close()
}
```

The three separately, when a test needs its own wiring:

```ts
const as = await startLocalAuthorizationServer({ enterprise: { /* ... */ } })
const mcp = await startLocalMcpServer({
  requireAuth: true,
  authorizationServers: [as.issuer],
  validTokens: as.validTokens, // the authorization server decides which tokens work
})
as.resource = mcp.url // an ID-JAG that names another resource is refused
```

Options every server takes: `host` (`'127.0.0.1'` by default, or `'::1'`), `port` (default `0`: any
free port) and `cors`.

### What a test can read back

- IdP: `exchanges` (every token-exchange request: parameters, how the client authenticated, the
  status answered), `issuedIdJags`.
- Authorization server: `tokenRequests()` (parameters, auth method, the OAuth error answered),
  `grants()`, `tokenClientIds()`, `registrations()`, `cimdFetches`, `validTokens`.
- MCP server: `calls` (every tool call), `initializeCapabilities`, `secret` (what the `secret` tool
  returns: a value a model cannot know without calling it).

`peekJwt`, `verifyJwt`, `signJwt`, `generateClientKey` and the grant / token-type constants are
exported for assertions about what was sent.

## The misbehaviour switches

Set one at a time; that is how a negative test stays about one thing.

**IdP** — `idp.misbehave`, mutable while it runs:

| Field | The exchange then |
| --- | --- |
| `issuedTokenType` | answers with this `issued_token_type` instead of the ID-JAG type |
| `omitToken` | leaves `access_token` out |
| `audience` | puts this `aud` in the ID-JAG, whatever was asked |
| `expired` | issues an ID-JAG that expired a minute ago |
| `rejectClient` | refuses the right credentials (401 `invalid_client`) |
| `deny` | refuses by policy (400 `access_denied`) with this description |
| `redirectTo` | answers 307 to this URL |
| `echoRequest` | refuses and quotes the whole request body in `error_description` |

**Authorization server** — `as.faults` (or `mcp.faults` on the pair), enterprise mode:

| Field | The token endpoint then |
| --- | --- |
| `refuseGrant: { error, description }` | answers every grant with that OAuth error |
| `echoRequest` | refuses and quotes the whole request body (also `enterprise.echoAssertion` at start) |

**MCP server** — `mcp.structuredFaults` (with `structuredTools`):

| Field | `report` / `report_mixed` then |
| --- | --- |
| `result: 'mismatch'` | answer with `structuredContent` that breaks the declared `outputSchema` (`temperature` is a string) |
| `result: 'missing'` | answer with no `structuredContent` at all, while `tools/list` still declares the schema |

**Options that change what a server accepts:**

| Option | Where | Effect |
| --- | --- | --- |
| `assertionProfile` | IdP, `enterprise` | What a `private_key_jwt` client assertion must look like. `'rfc7523bis'` (default): `aud` = the issuer, `typ: client-authentication+jwt`. `'rfc7523'`: `aud` = the token endpoint, `typ: JWT` or none. Each refuses the other's form. |
| `clientSecret` omitted | IdP, `enterprise` | No secret is accepted; with `enterprise` and no `clientJwks`, a public client (`client_id` alone). |
| `clientJwks` | IdP, `enterprise` | The client authenticates with `private_key_jwt`; a secret is refused. |
| `cimd: { resolve }` | `enterprise` | Accept a `client_id` that is a client ID metadata document URL; `resolve` maps the https URL to the test server that hosts it. |
| `idJagExpiresIn`, `expiresIn` | IdP, authorization server | Lifetimes, to test expiry. |
| `clientIdMetadataDocument`, `issParameter` | authorization server | Advertise those two metadata flags. |
| `idTokenEndpoint` | IdP | Serve `GET /test/id-token` (a fresh ID token for anyone): for a harness in another process. Off by default. |
| `requireAuth` | MCP server | Answer 401 with `WWW-Authenticate` until the bearer token is in `validTokens`. |

There is no `/authorize` page: a test that needs the interactive flow plays the redirect itself.

## CORS

`cors: '<origin>'` (or `'*'`) on any of the servers answers the preflight (`204`) and puts these on
every answer, errors and the 401 challenge included — what a browser MCP client needs, and what the
browser package's README asks of a real deployment:

```
Access-Control-Allow-Origin:   <origin>
Access-Control-Allow-Methods:  GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers:  Content-Type, Authorization, mcp-session-id, MCP-Protocol-Version, Last-Event-ID
Access-Control-Expose-Headers: WWW-Authenticate, mcp-session-id
Access-Control-Max-Age:        86400
```

Without the option no CORS header is sent at all.

## The CLI

For a harness that cannot call functions — a Playwright `webServer`, a browser test:

```bash
node packages/test-servers/src/cli.ts --idp --as --mcp --port-base 0 --cors http://localhost:5173
```

(Node before 22.18 needs `--experimental-strip-types`; `pnpm --filter @dudko.dev/test-servers start
--idp ...` passes it.) It prints **one line of JSON** on stdout - warnings, if any, go to stderr -
and serves until `SIGINT` / `SIGTERM`:

```json
{"cors":"http://localhost:5173","idp":{"issuer":"http://127.0.0.1:40001","tokenEndpoint":"http://127.0.0.1:40001/token","jwksUri":"...","idTokenEndpoint":"http://127.0.0.1:40001/test/id-token","assertionProfile":"rfc7523bis","clientId":"test-agent-at-idp","clientAuthMethod":"client_secret_basic","clientSecret":"<generated>"},"as":{"issuer":"http://127.0.0.1:40002","tokenEndpoint":"http://127.0.0.1:40002/token","mode":"enterprise","assertionProfile":"rfc7523bis","clientId":"test-agent-at-as","clientAuthMethod":"client_secret_basic","clientSecret":"<generated>"},"mcp":{"url":"http://127.0.0.1:40003/mcp","requireAuth":true}}
```

| Flag | Meaning |
| --- | --- |
| `--idp`, `--as`, `--mcp` | Which servers to start. None named = all three. `--as` with `--idp` is the enterprise authorization server; without, the interactive one. `--mcp` with `--as` requires a token from it. |
| `--port-base <n>` | `0` (default): any free ports. Otherwise the IdP on `n`, the authorization server on `n+1`, the MCP server on `n+2`. |
| `--host <address>` | `127.0.0.1` (default) or `::1`. Anything else exits with status 2. |
| `--cors <origin>` | CORS for that origin on every server started. |
| `--client-auth <secret\|private_key_jwt>` | How the test client authenticates on both hops. With `private_key_jwt` the line carries `privateJwk`, `keyId` and `algorithm` instead of `clientSecret`. |
| `--assertion-profile <rfc7523bis\|rfc7523>` | The form of client assertion the servers accept. |

The ID token a browser harness needs comes from `GET <idp.idTokenEndpoint>` (`{"id_token": "..."}`),
which the CLI switches on. The same thing from code: `startFromCli(parseCliArgs([...]))` returns
`{ info, close }`.

## Checks

```bash
pnpm nx run-many -t typecheck format:check test -p @dudko.dev/test-servers
```
