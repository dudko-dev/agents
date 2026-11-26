import { randomBytes, type JsonWebKey } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  startLocalAuthorizationServer,
  type ILocalAuthorizationServer,
} from './authorization-server.ts'
import { assertLoopbackHost } from './http.ts'
import { startLocalIdp, type ILocalIdp } from './idp-server.ts'
import { generateClientKey, type ClientAssertionProfile } from './jwt.ts'
import { startLocalMcpServer, type ILocalMcpServer, type McpProtocol } from './mcp-server.ts'

/**
 * The test servers as a process, for a harness that cannot call them as
 * functions (a Playwright `webServer`, a browser test):
 *
 *   node packages/test-servers/src/cli.ts --idp --as --mcp --port-base 0 --cors http://localhost:5173
 *
 * It prints ONE line of JSON on stdout - the URLs and the credentials it
 * generated - and then serves until it is told to stop (SIGINT / SIGTERM).
 * Everything in that line was made up at start-up and dies with the process.
 */

export const CLI_HELP = `Usage: node src/cli.ts [--idp] [--as] [--mcp] [options]

Servers (none named = all three):
  --idp                      the test enterprise identity provider
  --as                       the test MCP authorization server
                             (with --idp: enterprise-managed authorization only;
                             without: dynamic registration and a plain token endpoint)
  --mcp                      the test MCP server (with --as: requires a token from it)

Options:
  --port-base <n>            0 (default): any free ports. Otherwise the IdP listens on n,
                             the authorization server on n+1, the MCP server on n+2
  --host <address>           127.0.0.1 (default) or ::1. Nothing else is accepted
  --cors <origin>            answer CORS for this origin ('*' for any)
  --client-auth <method>     how the test client authenticates on both hops:
                             secret (default) or private_key_jwt
  --assertion-profile <p>    what a private_key_jwt assertion must look like:
                             rfc7523bis (default: aud = issuer, typ client-authentication+jwt)
                             or rfc7523 (aud = token endpoint, typ JWT)
  --protocol <revisions>     what the MCP server speaks: legacy (default: the 2025 revisions,
                             an initialize handshake), modern (2026-07-28 only: no handshake,
                             no session) or dual (both on the one endpoint)
  --help                     this text

Prints one JSON line with the URLs and the generated credentials, then serves until SIGINT/SIGTERM.
For tests only: loopback, no persistence, tokens for anyone who asks correctly.`

export interface ICliArgs {
  idp: boolean
  as: boolean
  mcp: boolean
  portBase: number
  host: string
  cors?: string
  clientAuth: 'secret' | 'private_key_jwt'
  assertionProfile: ClientAssertionProfile
  protocol: McpProtocol
  help: boolean
}

/** Parse the flags. Throws on anything it does not know: a typo must not start a different setup. */
export const parseCliArgs = (argv: string[]): ICliArgs => {
  const args: ICliArgs = {
    idp: false,
    as: false,
    mcp: false,
    portBase: 0,
    host: '127.0.0.1',
    clientAuth: 'secret',
    assertionProfile: 'rfc7523bis',
    protocol: 'legacy',
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = (): string => {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${flag} needs a value`)
      }
      i += 1
      return next
    }
    if (flag === '--idp' || flag === '--as' || flag === '--mcp' || flag === '--help') {
      args[flag.slice(2) as 'idp' | 'as' | 'mcp' | 'help'] = true
    } else if (flag === '--port-base') {
      const raw = value()
      const port = Number(raw)
      if (!/^\d+$/.test(raw) || port > 65533) {
        throw new Error(`--port-base must be 0 or a port number up to 65533, got "${raw}"`)
      }
      args.portBase = port
    } else if (flag === '--host') {
      args.host = value()
    } else if (flag === '--cors') {
      args.cors = value()
    } else if (flag === '--client-auth') {
      const method = value()
      if (method !== 'secret' && method !== 'private_key_jwt') {
        throw new Error(`--client-auth must be secret or private_key_jwt, got "${method}"`)
      }
      args.clientAuth = method
    } else if (flag === '--assertion-profile') {
      const profile = value()
      if (profile !== 'rfc7523bis' && profile !== 'rfc7523') {
        throw new Error(`--assertion-profile must be rfc7523bis or rfc7523, got "${profile}"`)
      }
      args.assertionProfile = profile
    } else if (flag === '--protocol') {
      const protocol = value()
      if (protocol !== 'legacy' && protocol !== 'modern' && protocol !== 'dual') {
        throw new Error(`--protocol must be legacy, modern or dual, got "${protocol}"`)
      }
      args.protocol = protocol
    } else {
      throw new Error(`unknown option "${flag}" (see --help)`)
    }
  }
  if (!args.idp && !args.as && !args.mcp) {
    args.idp = args.as = args.mcp = true
  }
  assertLoopbackHost(args.host)
  return args
}

/** How the test client authenticates at one server, as printed. */
interface ICliClient {
  clientId: string
  clientAuthMethod: 'client_secret_basic' | 'private_key_jwt' | 'none'
  clientSecret?: string
  /** With `private_key_jwt`: the key to sign with, its id and algorithm. */
  privateJwk?: JsonWebKey
  keyId?: string
  algorithm?: 'ES256'
}

/** The JSON line: where everything is, and the credentials generated for this run. */
export interface ICliInfo {
  idp?: ICliClient & {
    issuer: string
    tokenEndpoint: string
    jwksUri: string
    /** `GET` it for a fresh ID token of the test user: `{ "id_token": "..." }`. */
    idTokenEndpoint: string
    assertionProfile: ClientAssertionProfile
  }
  as?: Partial<ICliClient> & {
    issuer: string
    tokenEndpoint: string
    /** `enterprise`: the jwt-bearer grant with an ID-JAG only. `interactive`: registration and a token endpoint. */
    mode: 'enterprise' | 'interactive'
    assertionProfile?: ClientAssertionProfile
  }
  mcp?: { url: string; requireAuth: boolean; protocol: McpProtocol }
  cors?: string
}

export interface ICliServers {
  info: ICliInfo
  idp?: ILocalIdp
  as?: ILocalAuthorizationServer
  mcp?: ILocalMcpServer
  close: () => Promise<void>
}

const newSecret = (): string => randomBytes(24).toString('base64url')

/** Start what the arguments ask for. The caller prints `info` and, later, calls `close`. */
export const startFromCli = async (args: ICliArgs): Promise<ICliServers> => {
  const listenAt = (slot: number) => ({
    host: args.host,
    cors: args.cors,
    port: args.portBase === 0 ? 0 : args.portBase + slot,
  })
  const started: { close: () => Promise<void> }[] = []
  const close = async (): Promise<void> => {
    for (const server of started.reverse()) {
      await server.close()
    }
    started.length = 0
  }
  const info: ICliInfo = { ...(args.cors !== undefined ? { cors: args.cors } : {}) }
  const withKey = args.clientAuth === 'private_key_jwt'
  const credentials = (clientId: string) => {
    const key = withKey ? generateClientKey('ES256') : undefined
    const client: ICliClient = key
      ? {
          clientId,
          clientAuthMethod: 'private_key_jwt',
          privateJwk: key.privateJwk,
          keyId: key.kid,
          algorithm: 'ES256',
        }
      : { clientId, clientAuthMethod: 'client_secret_basic', clientSecret: newSecret() }
    return { client, jwks: key ? { keys: [key.publicJwk] } : undefined }
  }

  try {
    let idp: ILocalIdp | undefined
    let as: ILocalAuthorizationServer | undefined
    let mcp: ILocalMcpServer | undefined
    const asClientId = 'test-agent-at-as'
    if (args.idp) {
      const { client, jwks } = credentials('test-agent-at-idp')
      idp = await startLocalIdp({
        ...listenAt(0),
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        clientJwks: jwks,
        assertionProfile: args.assertionProfile,
        resourceClientId: asClientId,
        idTokenEndpoint: true,
      })
      started.push(idp)
      info.idp = {
        issuer: idp.issuer,
        tokenEndpoint: idp.tokenEndpoint,
        jwksUri: idp.jwksUri,
        idTokenEndpoint: idp.idTokenEndpoint as string,
        assertionProfile: args.assertionProfile,
        ...client,
      }
    }
    if (args.as) {
      const { client, jwks } = credentials(asClientId)
      as = await startLocalAuthorizationServer({
        ...listenAt(1),
        ...(idp
          ? {
              enterprise: {
                idpIssuer: idp.issuer,
                jwksUri: idp.jwksUri,
                clientId: client.clientId,
                clientSecret: client.clientSecret,
                clientJwks: jwks,
                assertionProfile: args.assertionProfile,
              },
            }
          : {}),
      })
      started.push(as)
      info.as = {
        issuer: as.issuer,
        tokenEndpoint: as.tokenEndpoint,
        mode: idp ? 'enterprise' : 'interactive',
        ...(idp ? { assertionProfile: args.assertionProfile, ...client } : {}),
      }
    }
    if (args.mcp) {
      mcp = await startLocalMcpServer({
        ...listenAt(2),
        requireAuth: as !== undefined,
        authorizationServers: as ? [as.issuer] : [],
        validTokens: as?.validTokens,
        protocol: args.protocol,
      })
      started.push(mcp)
      if (as) {
        as.resource = mcp.url
      }
      info.mcp = { url: mcp.url, requireAuth: as !== undefined, protocol: mcp.protocol }
    }
    return { info, idp, as, mcp, close }
  } catch (err) {
    await close()
    throw err
  }
}

const main = async (): Promise<void> => {
  let args: ICliArgs
  try {
    args = parseCliArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    process.exitCode = 2
    return
  }
  if (args.help) {
    process.stdout.write(`${CLI_HELP}\n`)
    return
  }
  const servers = await startFromCli(args)
  process.stdout.write(`${JSON.stringify(servers.info)}\n`)
  const stop = (): void => {
    void servers.close().then(() => process.exit(0))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

const isEntry = (): boolean => {
  try {
    return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isEntry()) {
  main().catch((err: Error) => {
    process.stderr.write(`${err.message}\n`)
    process.exit(1)
  })
}
