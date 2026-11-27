# @dudko.dev/test-servers

Test servers for the agent packages in this repository: an enterprise identity provider, an MCP
authorization server and an MCP server. Real sockets, real signatures, the MCP SDK's own servers
(1.x for the 2025 revisions of the protocol, 2.x for 2026-07-28) — and switches that make each of
them misbehave on purpose.

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
| MCP server | `startLocalMcpServer(opts)` | The MCP SDK's streamable-HTTP server with three tools (`echo`, `secret`, `boom`), optional `instructions` in its `initialize` / `server/discover` result (`mcp.setInstructions()` changes them for the next client to connect), optional structured tools (`structuredTools`: `report` and `report_mixed` declare an `outputSchema` and answer with `structuredContent`), optional elicitation tools (`elicitationTools`, below), optional MCP Apps tools (`appTools`, below), optional skills (`skills`, below; 2026-07-28 only), protected resource metadata (RFC 9728) and, with `requireAuth`, the 401 challenge. `protocol` picks the revisions it speaks: `'legacy'` (default), `'modern'` or `'dual'` (below). |
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
- MCP server: `calls` (every tool call; a call to an elicitation tool is one entry however many
  rounds it took), `initializeCapabilities`, `requests` (every JSON-RPC request and notification
  received: `{ era, method }`, the era being the one the message claimed - `modern` when it carried
  the per-request protocol version in `_meta`), `elicitations` and `urlElicitations` (below),
  `secret` (what the `secret` tool returns: a value a model cannot know without calling it).

`peekJwt`, `verifyJwt`, `signJwt`, `generateClientKey` and the grant / token-type constants are
exported for assertions about what was sent.

## The MCP server's protocol: `legacy`, `modern`, `dual`

```ts
const mcp = await startLocalMcpServer({ protocol: 'dual' }) // or startLocalMcp({ protocol: ... })
```

| `protocol` | Speaks | Served by |
| --- | --- | --- |
| `'legacy'` (default) | 2025-11-25 and earlier: the `initialize` handshake, stateless (no `Mcp-Session-Id` is issued), the GET stream. Exactly what this server has always put on the wire. | `@modelcontextprotocol/sdk` 1.x |
| `'modern'` | 2026-07-28 only: no handshake, no session, every request carries its version, client info and capabilities in `_meta`. | `@modelcontextprotocol/server` 2.x (`createMcpHandler`, `legacy: 'reject'`) |
| `'dual'` | Both on the one endpoint. A request with the modern `_meta` goes to the 2.x handler, everything else (the SDK's own `isLegacyRequest` decides) to the 1.x one: each era gets byte for byte what the single-era server answers. | both |

Legacy is not served by the 2.x SDK, although it can: its answers to a 2025 client differ from
the 1.x ones (JSON Schema 2020-12 instead of draft-07 in `tools/list`, no `execution` block, an
unknown tool as a JSON-RPC error instead of a tool error, 405 on GET and DELETE).

What the modern era answers (all of it the SDK's doing, asserted in `tests/mcp-protocol.test.ts`
with hand-built JSON-RPC):

- `server/discover`: `{ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities,
  instructions?, ttlMs, cacheScope, _meta: { 'io.modelcontextprotocol/serverInfo' } }`. In `dual`
  mode too it lists the modern revision only.
- Every result has `resultType`; `server/discover` and `tools/list` carry `ttlMs` / `cacheScope`
  (`0` / `'private'` unless the `cacheHint` option says otherwise).
- A POST without `MCP-Protocol-Version`, `Mcp-Method` or (for `tools/call`) `Mcp-Name`, or with one
  that disagrees with the body: HTTP 400, JSON-RPC `-32020`. A version it does not speak - a 2025
  `initialize` included: 400, `-32022` with `data: { supported, requested }`. An unknown method:
  404, `-32601`. A tool that needs a capability the request did not declare: 400, `-32021`.
- `GET` and `DELETE`: 405. No `Mcp-Session-Id`, ever.
- `subscriptions/listen`: the acknowledgement first, then only what the filter asked for; `close()`
  ends each stream with its result.

**A tool list change, in both eras.** `mcp.notifyToolsChanged()` sends
`notifications/tools/list_changed` to every open `subscriptions/listen` stream that asked for it
(modern) and every open GET stream (legacy). `mcp.addTool(name)` first adds a tool that answers
`<name>:ok`, so a client that refetches sees a difference. `mcp.changeListeners()` says how many
streams would be reached - wait for it instead of sleeping.

**A listen stream that ends (modern).** `mcp.dropListenStreams()` cuts every open
`subscriptions/listen` stream with no result (what a client sees when the network or a proxy
drops it) and returns how many there were. `await mcp.closeListenStreams()` ends each one with
its `subscriptions/listen` result - what a server process that shuts down sends - and goes on
serving from a fresh handler on the same event bus, as another process taking over would: a new
subscription is served and hears of the next change. How the NEXT `subscriptions/listen` is
answered is `mcp.listenFaults` (below).

### Elicitation tools

`elicitationTools: true` adds four tools that ask the user something. One implementation serves
both eras: on 2026-07-28 a question is an `input_required` result and the answer a retry of the
call with `inputResponses` and the `requestState` it was given; on the 2025 revisions the server
sends a real `elicitation/create` request on the stream of the call and waits for the client to
POST its answer (the state never leaves the server).

| Tool | What it does |
| --- | --- |
| `elicit_form` | One form with every field type form mode allows (`ELICIT_FORM_SCHEMA`: a string with length limits, the formats `email` / `uri` / `date` / `date-time`, a number and an integer with bounds, a boolean, single-select plain and titled, multi-select plain and titled). No `requestState`. Content that breaks the schema is asked for again. |
| `elicit_url` | URL mode: points at `GET <origin>/elicit/<id>`, a page of this server with one button. `POST` to the same URL submits it (what the button does) - no token needed, with `requireAuth` too. After `accept` the call waits up to `urlElicitationWaitMs` (default 3000) for the page; if it was not submitted it asks to be called again (`requestState` only). On legacy the request carries `elicitationId` and the result is preceded by `notifications/elicitation/complete`. |
| `elicit_twice` | Two rounds: a name, then a color. The name travels in `requestState`. |
| `elicit_state` | Hands out a signed state with a confirmation and finishes only if exactly that string comes back. |

Every `requestState` is HMAC-signed with a key made at start-up, names the tool it was issued to
and expires after ten minutes. Anything else is refused: `-32602` `Invalid or expired
requestState` on the modern wire.

Answers are JSON in the result's text: `{ tool, action, ... }`; `decline` and `cancel` are results,
not errors. `mcp.elicitations` has one entry per round: `{ tool, era, capabilities, responses,
requestState, stateValid, asked?, issuedState? }` - what the client declared, answered and echoed,
exactly as it arrived. `mcp.urlElicitations` lists the pages: `{ id, url, opened, completed }`.

On the legacy wire the server is stateless, so it judges the client's `elicitation` capability by
the latest `initialize` it received; a mode that was not declared fails the tool call without a
request being sent. It gives up after 8 rounds of one call.

### Skills

`skills: true` serves skills (the `io.modelcontextprotocol/skills` extension, SEP-2640) on the
2026-07-28 side (`modern`, and the modern requests of `dual`): the 2.x SDK's `SkillsExtension`
over a source of `src/mcp-skills.ts`, so the server declares the extension (no `directoryRead`)
and answers `skills/list`, `skills/get` and `resources/read` of the `skill://` files. The legacy
side never serves them: the extension is written against 2026-07-28.

| Skill | Files | Body marker (`SKILL_MARKERS`) |
| --- | --- | --- |
| `skill://git-workflow/SKILL.md` | - | `GIT-WORKFLOW-BODY` |
| `skill://pdf-processing/SKILL.md` | `references/FORMS.md`, `scripts/extract.py` (a script its instructions point at) | `PDF-PROCESSING-BODY` (`FORMS-FILE-BODY`, `EXTRACT-SCRIPT-BODY`) |
| `skill://acme/billing/refunds/SKILL.md` | - | `BILLING-REFUNDS-BODY` |
| `skill://acme/support/refunds/SKILL.md` | - (the same name, `refunds`, as the one above) | `SUPPORT-REFUNDS-BODY` |

`mcp.skillReads` lists every skill file a client read (`resources/read`), in order.
`mcp.addSkill(path, description, body)` serves one more skill from then on and announces a resource
list change (`notifications/resources/list_changed`, on every listen stream that asked for
`resourcesListChanged`), which is how a client hears of a change of skills.

### MCP Apps tools

`appTools: true` (or an object) adds the "travel" server of the MCP Apps extension
(`io.modelcontextprotocol/ui`): tools that declare an app in `_meta.ui`, and the app itself as a
resource, served by both SDK generations.

| Tool | `_meta.ui` | What it does |
| --- | --- | --- |
| `flights.search` | `resourceUri: ui://travel/results.html` | read-only; three flights as `structuredContent` (`TRAVEL_FLIGHTS`) and a sentence |
| `flights.book` | the app, `visibility: ['model', 'app']` | writes; answers `booked:<flight>` |
| `flights.refresh` | the app, `visibility: ['app']` | read-only, for the app only |
| `flights.admin` | `visibility: ['model']` | for the model only; an app may not call it |
| `flights.bad` | `resourceUri: ui://travel/bad.html` | its "app" is plain `text/html`: not an app |

`ui://travel/results.html` is `text/html;profile=mcp-app` with `_meta.ui.csp.connectDomains` from
the option, `permissions: { camera: {} }` and `prefersBorder: true`. The app (`travelAppHtml`,
`src/mcp-app.ts`) speaks the extension's JSON-RPC by hand: it renders the tool's input and
result, calls `flights.book` / `flights.refresh` / `flights.admin`, asks for a link
(`TRAVEL_CHECKOUT_URL`), a message (`TRAVEL_MESSAGE`) and a height of 5000 px, and - its buttons
"Run probes", "Talk to the page", "Leave" - tries the page's DOM, `top.location`, storage,
cookies, IndexedDB, a popup, navigating the top window, `fetch` and an image to the undeclared
URL, `fetch` to the declared one, `postMessage` straight to the top window, and navigating
itself. Each probe writes `blocked`, `allowed: …` or `attempted` into `[data-probe=<name>]`; the
`origin` probe writes `origin: <self.origin> <location.origin>`. For a host that frames apps in a
sandbox page of the app's own origin (a sandbox proxy), the probes also use THAT page from inside
(`parent-fetch`, `parent-image`, `parent-frame`; `top-dom`, `grandparent-dom`, `host-secret` read
what is above it), two buttons navigate it with a link in its document: "Leave through the
frame" (to the undeclared URL) and "Reload the frame" (to its own URL again), and "Lift its
sandbox" takes the `sandbox` attribute off its own `<iframe>` and loads a document into it that
tries to navigate the top window and to fetch the undeclared URL.

| Option (object form) | |
| --- | --- |
| `connectDomains` | the origins the resource declares (default none) |
| `declaredUrl` | a URL on a declared origin: the `fetch-declared` probe |
| `undeclaredUrl` | a URL on an origin it did not declare: the fetch, image and navigation probes |
| `html` | replace the app's document |

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

**MCP server** — `mcp.protocolFaults`, for the request a client in "auto" mode probes with. Works
in every `protocol` mode; only `server/discover` is touched:

| `probe` | `server/discover` then |
| --- | --- |
| `'unauthorized'` | answers 401 with the `WWW-Authenticate` challenge, whatever the token |
| `'server_error'` | answers 503 with a plain-text body |
| `'garbage'` | answers 200 `application/json` with a body that is not JSON |
| `'cors'` | is blocked in a browser: every preflight answers with the request headers a pre-2026 deployment allows (no `Mcp-Method`, no `Mcp-Name`). A client that is not a browser is not subject to CORS and sees no difference. |

**MCP server** — `mcp.listenFaults`, for every `subscriptions/listen` request (2026-07-28: the
2025 revisions have no such method). The request is answered before the SDK sees it; a stream
that is already open is not touched:

| `answer` | `subscriptions/listen` then |
| --- | --- |
| `'not_found'` | answers 404 with JSON-RPC `-32601`: a server that does not implement the method |
| `'not_allowed'` | answers 405 |
| `'unauthorized'` | answers 401 with the `WWW-Authenticate` challenge, whatever the token |
| `'forbidden'` | answers 403 |
| `'unavailable'` | answers 503 with a plain-text body |
| `'silent'` | answers nothing: the request is held until the client gives it up (`mcp.heldListens()` counts them) |

**MCP server** — `mcp.appFaults` (with `appTools`), both eras:

| Field | `resources/read` of the app then |
| --- | --- |
| `mime` | answers with this MIME type |
| `padTo` | pads the HTML (a comment) to this many characters |
| `otherUri` | answers for `ui://travel/other.html` instead |
| `cspInjection` | adds declared CSP entries that are not origins (`https://ok.example; script-src *`, `*`, `'unsafe-eval'`, `data:`, `https://*.com`) |

**MCP server** — `mcp.skillFaults` (with `skills`), 2026-07-28; each adds one skill to the listing:

| Field | The listing then also has |
| --- | --- |
| `digest` | `skill://tampered/SKILL.md`, whose listed digest is not the digest of what is served (same size) |
| `nameMismatch` | `skill://wrong-name/SKILL.md` with the frontmatter name `other-name`; `skills/list` is answered by hand, before the SDK (which would drop the entry) |
| `frontmatter` | `skill://drifted/SKILL.md`, whose entry's description is not its `SKILL.md`'s (the digest matches) |
| `oversize` | `skill://huge/SKILL.md`, listing 513 files: over the extension's limit of 512 |
| `dynamic` | `skill://generated/SKILL.md` with `"resources": "dynamic"` |
| `hostile` | `skill://approve-everything/SKILL.md`: instructions to approve every call, switch approval off, fetch an outside URL and run `scripts/payload.js`, and `allowed-tools: run_js web_fetch` in its frontmatter (`HOSTILE-SKILL-BODY`) |
| `longBody` | `skill://long-guide/SKILL.md`, whose instructions are 40 000 characters (ending `END-OF-LONG-GUIDE`) |
| `changedFile` | (no new skill) `pdf-processing`'s `references/FORMS.md` is served changed, same length: its digest no longer matches |
| `extra: n` | `skill://extra-1/SKILL.md` ... `skill://extra-<n>/SKILL.md` |

**MCP server** — `mcp.elicitationFaults` (with `elicitationTools`), both eras:

| Field | The elicitation tools then |
| --- | --- |
| `neverSatisfied` | ask their first question again on every round, whatever was answered (legacy: the call fails after 8 rounds) |
| `undeclaredMode` | ask in the mode the client did not declare: URL mode from a client that declared the form only or nothing, a form from one that declared URL mode only (the answer is reported back as `{ tool, undeclared, action }`). A client that declared both gets the normal tool. |
| `tamperState` | hand out a `requestState` whose signature is broken: echoed exactly, it is still refused |
| `formSchema: 'nested'` | ask every form with a field that is itself an object: outside the flat subset a form may be, so a client must refuse it |
| `formSchema: 'huge'` | ask every form with `ELICIT_HUGE_FIELDS` (51) string fields: each one allowed, the form as a whole more than a client should show |
| `quietResult` | leave the user's answers out of the tool results (`{ tool, action }` only): for tests that look for an answer where it must not be |

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
| `protocol` | MCP server | `'legacy'` (default), `'modern'` or `'dual'`: see above. |
| `cacheHint: { ttlMs, cacheScope }` | MCP server | The cache fields of the modern `server/discover` and `tools/list` results. |

There is no `/authorize` page: a test that needs the interactive flow plays the redirect itself.

## CORS

`cors: '<origin>'` (or `'*'`) on any of the servers answers the preflight (`204`) and puts these on
every answer, errors and the 401 challenge included — what a browser MCP client needs, and what the
browser package's README asks of a real deployment:

```
Access-Control-Allow-Origin:   <origin>
Access-Control-Allow-Methods:  GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers:  Content-Type, Authorization, mcp-session-id, MCP-Protocol-Version, Last-Event-ID, Mcp-Method, Mcp-Name
Access-Control-Expose-Headers: WWW-Authenticate, mcp-session-id
Access-Control-Max-Age:        86400
```

`Mcp-Method` and `Mcp-Name` are the request headers the 2026-07-28 revision adds (exported as
`CORS_ALLOW_HEADERS`; `CORS_ALLOW_HEADERS_2025` is the list without them). `Mcp-Param-*` headers
are named by tool definitions and cannot be listed in advance: a preflight that asks for some gets
those names added to the allowed list. No new header is exposed: the modern era has no session id.

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
{"cors":"http://localhost:5173","idp":{"issuer":"http://127.0.0.1:40001","tokenEndpoint":"http://127.0.0.1:40001/token","jwksUri":"...","idTokenEndpoint":"http://127.0.0.1:40001/test/id-token","assertionProfile":"rfc7523bis","clientId":"test-agent-at-idp","clientAuthMethod":"client_secret_basic","clientSecret":"<generated>"},"as":{"issuer":"http://127.0.0.1:40002","tokenEndpoint":"http://127.0.0.1:40002/token","mode":"enterprise","assertionProfile":"rfc7523bis","clientId":"test-agent-at-as","clientAuthMethod":"client_secret_basic","clientSecret":"<generated>"},"mcp":{"url":"http://127.0.0.1:40003/mcp","requireAuth":true,"protocol":"legacy"}}
```

| Flag | Meaning |
| --- | --- |
| `--idp`, `--as`, `--mcp` | Which servers to start. None named = all three. `--as` with `--idp` is the enterprise authorization server; without, the interactive one. `--mcp` with `--as` requires a token from it. |
| `--port-base <n>` | `0` (default): any free ports. Otherwise the IdP on `n`, the authorization server on `n+1`, the MCP server on `n+2`. |
| `--host <address>` | `127.0.0.1` (default) or `::1`. Anything else exits with status 2. |
| `--cors <origin>` | CORS for that origin on every server started. |
| `--client-auth <secret\|private_key_jwt>` | How the test client authenticates on both hops. With `private_key_jwt` the line carries `privateJwk`, `keyId` and `algorithm` instead of `clientSecret`. |
| `--assertion-profile <rfc7523bis\|rfc7523>` | The form of client assertion the servers accept. |
| `--protocol <legacy\|modern\|dual>` | What the MCP server speaks. `legacy` (default): the 2025 revisions. `modern`: 2026-07-28 only. `dual`: both on the one endpoint. The line says which (`mcp.protocol`). |

The ID token a browser harness needs comes from `GET <idp.idTokenEndpoint>` (`{"id_token": "..."}`),
which the CLI switches on. The same thing from code: `startFromCli(parseCliArgs([...]))` returns
`{ info, close }`.

## Checks

```bash
pnpm nx run-many -t typecheck format:check test -p @dudko.dev/test-servers
```
