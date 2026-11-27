# app-sandbox — the demo's MCP Apps sandbox page

A Cloudflare Worker, private, never published. It serves ONE thing on its own domain,
**https://agent-demo-apps.dudko.dev**: the MCP Apps sandbox page of
[`@dudko.dev/agent-web-react/mcp-app-sandbox`](../../packages/agent-web-react/docs/chat.md#an-app-on-an-origin-of-its-own),
at `/sandbox/v1/<policy>`. The demo (https://agent.dudko.dev/demo/) frames it, so that an MCP App
runs on an origin of its own - `agent-demo-apps.dudko.dev`, never `agent.dudko.dev` - with storage
of its own and a real `Origin` on its requests (the specification's "sandbox proxy").

It is **not** the site's Worker (`apps/worker`, the root `wrangler.jsonc`): the site's requests
never reach it, `pnpm nx build site` does not build it, and it is deployed by a Workers Builds
project of its own (below). One Custom Domain: a domain per MCP server (`{server}.…`) would need a
wildcard certificate, which Cloudflare sells (Advanced Certificate Manager), so every app of every
server shares this one origin - see the trade-off in
[docs/chat.md](../../packages/agent-web-react/docs/chat.md#an-app-on-an-origin-of-its-own).

| Request | Answer |
| --- | --- |
| `GET` / `HEAD /sandbox/v1/<policy>` | the page, with the app's policy and `frame-ancestors` as headers |
| a `<policy>` the library would not write | 400 |
| another method on that path | 405 |
| anything else (`/`, `/sandbox/v1`, `/robots.txt`, …) | 404 |
| `ALLOWED_HOST_ORIGINS` missing or with an invalid entry | 503 |

Every answer: `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff`,
`Strict-Transport-Security: max-age=31536000`.

## Configuration

`wrangler.jsonc` (in this directory) is the whole of it:

- `name: "agent-demo-apps"`, `main: "./dist/index.js"` (built by `pnpm nx build app-sandbox`).
- `workers_dev: false`, `preview_urls: false`, and one route: the Custom Domain
  `agent-demo-apps.dudko.dev`.
- `vars.ALLOWED_HOST_ORIGINS = "https://agent.dudko.dev https://*-agents.dudko.workers.dev"` - who
  may frame the page and hand it an app: the site, and the site's Cloudflare previews
  (`<version>-agents.dudko.workers.dev`). In the page's script the `*` is ONE label fragment
  (`[a-z0-9-]+`, no dot); `frame-ancestors` cannot say that and gets `https://*.dudko.workers.dev`
  (any Worker of the account on its workers.dev subdomain may frame the page; only the exact
  patterns may hand it an app). Change this if the site's Worker or the account's workers.dev
  subdomain is renamed.
- No assets, no binding, no secret, no compatibility flag, no observability: nothing is stored or
  logged.

## Set up on Cloudflare (once, by the owner)

1. **Workers & Pages → Create → Import a repository** (Workers Builds) and pick
   `dudko-dev/agents` - the same repository as the site's project, a second project.
2. **Project name: `agent-demo-apps`.** Workers Builds requires the Worker's name to be the `name`
   in the Wrangler file it deploys.
3. **Build configuration:**

   | Setting | Value |
   | --- | --- |
   | Production branch | `main` |
   | Root directory | `/` (the repository root: the pnpm workspace installs there) |
   | Build command | `pnpm nx build app-sandbox` |
   | Deploy command | `npx wrangler deploy --config apps/app-sandbox/wrangler.jsonc` |
   | Builds for non-production branches | **off** (the demo's previews use the production sandbox; a preview of this Worker is never framed). If you keep it on, the command is `npx wrangler versions upload --config apps/app-sandbox/wrangler.jsonc` |
   | Build watch paths (optional) | include `apps/app-sandbox/*`, `packages/agent-web-react/*`, `pnpm-lock.yaml` |
   | Environment variables | none (the hosts are `vars` in `wrangler.jsonc`); the same Node as the site's project (≥ 22.6) |

   The build builds the core, the React package (whose `./mcp-app-sandbox` entry the Worker
   bundles) and this Worker - nothing of the demo or the site.
4. **The Custom Domain.** The deploy attaches `agent-demo-apps.dudko.dev` itself (the route has
   `custom_domain: true`; the `dudko.dev` zone must be in the same account). If the build's token
   may not do that, add it by hand: the Worker → **Settings → Domains & Routes → Add → Custom
   domain** → `agent-demo-apps.dudko.dev`. Cloudflare creates the DNS record and the certificate;
   do not create a DNS record for that name first (an existing record makes it fail).
5. **Check it:**

   ```bash
   curl -sI https://agent-demo-apps.dudko.dev/sandbox/v1/eyJjIjpbXSwiciI6W119
   # 200, content-security-policy: default-src 'none'; … ; frame-ancestors https://agent.dudko.dev https://*.dudko.workers.dev
   curl -sI https://agent-demo-apps.dudko.dev/        # 404
   ```

   Then https://agent.dudko.dev/demo/ → MCP tab → connect a server whose tool comes with an app
   (the demo server has none yet) → the app's header says **sandboxed on its own origin** (until
   the domain answers, it says "sandboxed", and the menu says the sandbox page did not answer).

Nothing changes in the site's project: it keeps building `pnpm nx build site` and deploying the
root `wrangler.jsonc`.

## Commands

```bash
pnpm nx run-many -t typecheck format:check build test -p app-sandbox
npx wrangler dev --config apps/app-sandbox/wrangler.jsonc --local   # after the build; wrangler is not a dependency
```

Locally and in the browser tests the demo does not use this Worker: `vite dev` / `vite preview`
serve the same page with the same handler under the other loopback name (`apps/demo/vite.config.ts`).
