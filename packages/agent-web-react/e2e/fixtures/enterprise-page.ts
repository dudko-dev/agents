import {
  connectMcpHttp,
  createEnterpriseOAuthProvider,
  EnterpriseOAuthError,
  type ConnectedMcp,
} from '@dudko.dev/agent-web/mcp'

/**
 * A TEST-ONLY page: the core's enterprise-managed MCP authorization (ID-JAG) in a real browser.
 *
 * Not part of the demo, not part of any published package and never deployed: `page-server.ts`
 * bundles this file when the browser test starts and serves it on loopback for that test alone.
 *
 * The React hooks take no `authProvider`, so there is nothing of this package to drive here: the
 * page calls the core the way a host would - `createEnterpriseOAuthProvider` handed to
 * `connectMcpHttp` - and puts every outcome, and every log line, ON THE PAGE. That is the point of
 * it: what a host would show a user is what the test reads back, so a token or a secret that
 * leaked into an error or the log would be found in the document.
 *
 * It has no interface of its own to translate: the words on it are states and values for the test
 * to read, not copy for a person.
 */

export interface EnterprisePageConfig {
  mcpUrl: string
  /** The issuer of the MCP server's authorization server. */
  expectedIssuer: string
  clientId: string
  clientSecret: string
  idp: {
    tokenEndpoint: string
    issuer: string
    clientId: string
    clientSecret: string
    clientAuthMethod?: 'client_secret_basic' | 'client_secret_post'
  }
  /** `GET` it for `{ id_token }`: stands in for the application's own single sign-on. */
  idTokenEndpoint: string
}

export interface EnterprisePageError {
  enterprise: boolean
  name: string
  hop?: string
  code?: string
  message: string
}

export interface EnterprisePageApi {
  configure: (config: EnterprisePageConfig) => void
  /** Connect through `connectMcpHttp`; resolves with the page's status. */
  connect: () => Promise<string>
  /** Run the flow by itself (`provider.authorize()`): a refusal is the error object itself. */
  authorize: () => Promise<EnterprisePageError | undefined>
  call: (tool: string, args: Record<string, unknown>) => Promise<void>
}

const SERVER = 'docs'

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const show = (id: string, text: string): void => {
  el(id).textContent = text
}

let config: EnterprisePageConfig | undefined
let connection: ConnectedMcp | undefined

const log = (level: string, message: string): void => {
  const line = document.createElement('li')
  line.textContent = `${level}: ${message}`
  el('log').append(line)
}

const provider = () => {
  if (!config) throw new Error('configure() first')
  const cfg = config
  return createEnterpriseOAuthProvider({
    serverUrl: cfg.mcpUrl,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    expectedIssuer: cfg.expectedIssuer,
    idp: cfg.idp,
    getIdToken: async () => {
      const res = await fetch(cfg.idTokenEndpoint)
      return ((await res.json()) as { id_token: string }).id_token
    },
    onLog: log,
  })
}

const showError = (err: unknown): EnterprisePageError => {
  const e = err as { name?: string; hop?: string; code?: string; message?: string }
  const shown: EnterprisePageError = {
    enterprise: err instanceof EnterpriseOAuthError,
    name: e?.name ?? typeof err,
    hop: e?.hop,
    code: e?.code,
    message: e?.message ?? String(err),
  }
  show('error-kind', shown.enterprise ? 'EnterpriseOAuthError' : shown.name)
  show('error-hop', shown.hop ?? '')
  show('error-code', shown.code ?? '')
  show('error', shown.message)
  return shown
}

const api: EnterprisePageApi = {
  configure(next) {
    config = next
    show('status', 'configured')
  },

  async connect() {
    show('status', 'connecting')
    await connection?.close().catch(() => {})
    connection = undefined
    const mcp = await connectMcpHttp(
      { [SERVER]: { url: (config as EnterprisePageConfig).mcpUrl, authProvider: provider() } },
      { clientName: 'enterprise-e2e', onLog: log },
    )
    const result = mcp.results[0]
    if (!result?.connected) {
      await mcp.close().catch(() => {})
      show('error', result?.error ?? 'no result')
      const status = result?.needsAuthorization ? 'needs-authorization' : 'error'
      show('status', status)
      return status
    }
    connection = mcp
    el('tools').replaceChildren(
      ...Object.keys(mcp.tools).map((name) => {
        const item = document.createElement('li')
        item.textContent = name
        return item
      }),
    )
    show('status', 'connected')
    return 'connected'
  },

  async authorize() {
    try {
      await provider().authorize({ onLog: log })
      show('status', 'authorized')
      return undefined
    } catch (err) {
      show('status', 'refused')
      return showError(err)
    }
  },

  async call(tool, args) {
    const tools = (connection?.tools ?? {}) as Record<
      string,
      { execute?: (args: unknown, options: unknown) => unknown }
    >
    try {
      const out = await tools[`${SERVER}__${tool}`]?.execute?.(args, {
        toolCallId: 'e2e',
        messages: [],
      })
      show('result', typeof out === 'string' ? out : JSON.stringify(out))
    } catch (err) {
      showError(err)
    }
  },
}

;(globalThis as unknown as { ema: EnterprisePageApi }).ema = api
show('status', 'ready')
