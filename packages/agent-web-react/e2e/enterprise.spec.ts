import { expect, test, type Page } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import {
  JWT_BEARER_GRANT,
  startLocalIdp,
  startLocalMcp,
  TOKEN_EXCHANGE_GRANT,
  type ILocalIdp,
  type ILocalMcp,
} from '@dudko.dev/test-servers'
import type {
  EnterprisePageApi,
  EnterprisePageConfig,
  EnterprisePageError,
} from './fixtures/enterprise-page.ts'
import { startPageServer, type IPageServer } from './page-server.ts'

/**
 * Enterprise-managed MCP authorization (ID-JAG) in a real browser.
 *
 * The provider is unit-tested in the core over mock fetches, and over sockets in the Node
 * package. What neither can show is the browser's half of it: the two token requests and the MCP
 * session are CROSS-ORIGIN from a page (preflights, `Authorization` on the IdP hop, the 401
 * challenge readable only when the server exposes `WWW-Authenticate`), the access token lives in
 * the IndexedDB vault under a WebCrypto key, and the place a leak would be seen is the document.
 *
 * The page is a test-only fixture (`fixtures/enterprise-page.ts`, bundled and served by
 * `page-server.ts`), not the demo: the React hooks have no enterprise mode, and the demo is what
 * gets deployed. The servers are `@dudko.dev/test-servers`: a real IdP that signs real tokens, an
 * authorization server that verifies the ID-JAG claim by claim, the SDK's MCP server. Every
 * credential below is generated for the run.
 */

const IDP_CLIENT = 'e2e-agent-at-idp'
const AS_CLIENT = 'e2e-agent-at-as'

let site: IPageServer
let idp: ILocalIdp
let mcp: ILocalMcp
let idpSecret: string
let asSecret: string
/** Every ID token the page fetched, and everything the page wrote to the console. */
let idTokens: string[]
let consoleLines: string[]

test.beforeAll(async () => {
  site = await startPageServer('enterprise-page.ts')
})

test.afterAll(async () => {
  await site.close()
})

test.beforeEach(async ({ page }) => {
  idpSecret = randomBytes(24).toString('base64url')
  asSecret = randomBytes(24).toString('base64url')
  idTokens = []
  consoleLines = []
  idp = await startLocalIdp({
    cors: site.origin,
    clientId: IDP_CLIENT,
    clientSecret: idpSecret,
    resourceClientId: AS_CLIENT,
    idTokenEndpoint: true,
  })
  mcp = await startLocalMcp({
    cors: site.origin,
    requireAuth: true,
    enterprise: {
      idpIssuer: idp.issuer,
      jwksUri: idp.jwksUri,
      clientId: AS_CLIENT,
      clientSecret: asSecret,
    },
  })
  page.on('console', (message) => consoleLines.push(message.text()))
  page.on('pageerror', (error) => consoleLines.push(String(error)))
  page.on('response', (response) => {
    if (response.url() !== idp.idTokenEndpoint) return
    void response
      .json()
      .then((body: { id_token?: string }) => {
        if (body.id_token) idTokens.push(body.id_token)
      })
      .catch(() => {})
  })
})

test.afterEach(async () => {
  await mcp.close()
  await idp.close()
})

type WithEma = { ema: EnterprisePageApi }

const open = async (
  page: Page,
  idpAuth?: EnterprisePageConfig['idp']['clientAuthMethod'],
): Promise<void> => {
  await page.goto(site.url)
  await expect(page.locator('#status')).toHaveText('ready')
  const config: EnterprisePageConfig = {
    mcpUrl: mcp.url,
    expectedIssuer: mcp.issuer,
    clientId: AS_CLIENT,
    clientSecret: asSecret,
    idp: {
      tokenEndpoint: idp.tokenEndpoint,
      issuer: idp.issuer,
      clientId: IDP_CLIENT,
      clientSecret: idpSecret,
      ...(idpAuth ? { clientAuthMethod: idpAuth } : {}),
    },
    idTokenEndpoint: idp.idTokenEndpoint as string,
  }
  await page.evaluate((c) => (globalThis as unknown as WithEma).ema.configure(c), config)
}

const connect = (page: Page): Promise<string> =>
  page.evaluate(() => (globalThis as unknown as WithEma).ema.connect())

const authorize = (page: Page): Promise<EnterprisePageError | undefined> =>
  page.evaluate(() => (globalThis as unknown as WithEma).ema.authorize())

const call = (page: Page, tool: string, args: Record<string, unknown>): Promise<void> =>
  page.evaluate(([t, a]) => (globalThis as unknown as WithEma).ema.call(t, a), [
    tool,
    args,
  ] as const)

/**
 * Nothing that must stay out of sight is in what a user (or their screenshot, or their console)
 * would see: the document's text, its markup, web storage, the address bar, the console.
 */
const expectNoSecretsOnThePage = async (page: Page): Promise<void> => {
  const seen = await page.evaluate(() =>
    [
      document.body.innerText,
      document.documentElement.outerHTML,
      JSON.stringify({ ...localStorage }),
      JSON.stringify({ ...sessionStorage }),
      location.href,
    ].join('\n'),
  )
  const surface = `${seen}\n${consoleLines.join('\n')}`
  // The test must have something to look for, or it proves nothing.
  expect(idTokens.length, 'the page fetched an ID token').toBeGreaterThan(0)
  const secrets: [string, string][] = [
    ['the IdP client secret', idpSecret],
    ['the authorization server client secret', asSecret],
    ...idTokens.map((t): [string, string] => ['an ID token', t]),
    ...idp.issuedIdJags.map((t): [string, string] => ['an ID-JAG', t]),
    ...[...mcp.validTokens].map((t): [string, string] => ['an access token', t]),
  ]
  for (const [what, value] of secrets) {
    // (The test authorization server's access tokens are short: `access-1`.)
    expect(value.length, what).toBeGreaterThanOrEqual(8)
    for (const spelling of new Set([value, encodeURIComponent(value)])) {
      expect(surface.includes(spelling), `${what} is visible on the page or in its console`).toBe(
        false,
      )
    }
    // A JWT cut short is still its claims: no part of one may show either.
    for (const part of value.split('.').filter((p) => p.length > 16)) {
      expect(surface.includes(part), `a part of ${what} is visible`).toBe(false)
    }
  }
}

test('enterprise: tools through the IdP exchange and the ID-JAG grant, a tool call, a reload', async ({
  page,
}) => {
  await open(page)
  expect(await connect(page)).toBe('connected')

  // No consent page, no redirect: the page is where it was, with the server's tools.
  await expect(page.locator('#status')).toHaveText('connected')
  await expect(page.locator('#tools li')).toHaveText(['docs__echo', 'docs__secret', 'docs__boom'])
  expect(page.url()).toBe(site.url)

  // Hop 1, at the IdP: one token exchange, the client authenticated, answered 200.
  expect(idp.exchanges).toHaveLength(1)
  expect(idp.exchanges[0].status).toBe(200)
  expect(idp.exchanges[0].authMethod).toBe('basic')
  expect(idp.exchanges[0].params.grant_type).toBe(TOKEN_EXCHANGE_GRANT)
  // The audience and the resource came from discovery in the browser, not from the test.
  expect(idp.exchanges[0].params.audience).toBe(mcp.issuer)
  expect(idp.exchanges[0].params.resource).toBe(mcp.url)
  // Hop 2, at the MCP authorization server: the ID-JAG, accepted.
  expect(mcp.grants()).toEqual([JWT_BEARER_GRANT])
  expect(mcp.tokenRequests()[0].params.assertion).toBe(idp.issuedIdJags[0])
  expect(mcp.validTokens.size).toBe(1)

  // A tool call reaches the server with the token that grant bought.
  await call(page, 'echo', { text: 'from the browser' })
  await expect(page.locator('#result')).toHaveText('echo:from the browser')
  expect(mcp.calls).toEqual([{ name: 'echo', args: { text: 'from the browser' } }])

  await expectNoSecretsOnThePage(page)

  // A reload: the access token is in the IndexedDB vault, so the page connects again without
  // asking the IdP or the authorization server for anything.
  await open(page)
  expect(await connect(page)).toBe('connected')
  await expect(page.locator('#tools li')).toHaveCount(3)
  expect(idp.exchanges).toHaveLength(1)
  expect(mcp.grants()).toHaveLength(1)
  await expectNoSecretsOnThePage(page)
})

test('enterprise: the IdP refuses the exchange - an EnterpriseOAuthError of the idp hop, nothing sent further', async ({
  page,
}) => {
  idp.misbehave.deny = 'The user is not assigned to this application'
  await open(page)

  // Through the connector: the server is not connected, and there is no one to send anywhere.
  expect(await connect(page)).toBe('error')
  await expect(page.locator('#status')).toHaveText('error')
  await expect(page.locator('#error')).toHaveText(
    'Enterprise IdP token exchange failed: the identity provider answered 400 access_denied - The user is not assigned to this application',
  )
  await expect(page.locator('#tools li')).toHaveCount(0)

  // The flow by itself: the error object, with the hop that refused.
  const refused = (await authorize(page)) as EnterprisePageError
  expect(refused.enterprise, 'instanceof EnterpriseOAuthError, in the page').toBe(true)
  expect(refused.name).toBe('EnterpriseOAuthError')
  expect(refused.hop).toBe('idp')
  expect(refused.code).toBe('access_denied')
  await expect(page.locator('#error-kind')).toHaveText('EnterpriseOAuthError')
  await expect(page.locator('#error-hop')).toHaveText('idp')
  await expect(page.locator('#error-code')).toHaveText('access_denied')

  // The IdP was asked, and said no each time; the authorization server and the MCP server's
  // tools never heard of it.
  expect(idp.exchanges.length).toBeGreaterThan(0)
  expect(idp.exchanges.every((exchange) => exchange.status === 400)).toBe(true)
  expect(idp.issuedIdJags).toHaveLength(0)
  expect(mcp.tokenRequests()).toHaveLength(0)
  expect(mcp.validTokens.size).toBe(0)
  expect(mcp.calls).toHaveLength(0)

  await expectNoSecretsOnThePage(page)
})

test('enterprise: an IdP that quotes the request back - the ID token and the secret it held are not on the page', async ({
  page,
}) => {
  // A careless server: its error_description is the whole request body. With client_secret_post
  // that body holds the client secret as well as the user's ID token.
  idp.misbehave.echoRequest = true
  await open(page, 'client_secret_post')

  expect(await connect(page)).toBe('error')
  const refused = (await authorize(page)) as EnterprisePageError
  expect(refused.enterprise).toBe(true)
  expect(refused.hop).toBe('idp')
  expect(refused.code).toBe('invalid_request')

  // The server's words are shown, which is what makes the next check mean something: the
  // quoted request is there, with what must not be read replaced.
  expect(idp.exchanges[0].authMethod).toBe('post')
  expect(idp.exchanges[0].params.client_secret).toBe(idpSecret)
  expect(idTokens).toContain(idp.exchanges[0].params.subject_token)
  await expect(page.locator('#error')).toContainText('bad request: grant_type=')
  await expect(page.locator('#error')).toContainText('[redacted]')
  expect(mcp.tokenRequests()).toHaveLength(0)

  await expectNoSecretsOnThePage(page)
})
