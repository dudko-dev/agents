import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createPrivateKey, type JsonWebKey } from 'node:crypto'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CLIENT_ASSERTION_TYPE,
  parseCliArgs,
  signJwt,
  startFromCli,
  startLocalMcpServer,
} from '../src/index.ts'
import { basic, exchangeParams, getJson, grantParams, postForm } from './helpers.ts'

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

// ── the flags ─────────────────────────────────────────────────────────────

test('cli args: defaults, and every flag', () => {
  assert.deepEqual(parseCliArgs([]), {
    idp: true,
    as: true,
    mcp: true,
    portBase: 0,
    host: '127.0.0.1',
    clientAuth: 'secret',
    assertionProfile: 'rfc7523bis',
    help: false,
  })
  // Naming servers starts only those.
  const some = parseCliArgs(['--mcp'])
  assert.deepEqual([some.idp, some.as, some.mcp], [false, false, true])
  assert.deepEqual(
    parseCliArgs([
      '--idp',
      '--as',
      '--mcp',
      '--port-base',
      '4100',
      '--cors',
      'http://localhost:5173',
      '--host',
      '::1',
      '--client-auth',
      'private_key_jwt',
      '--assertion-profile',
      'rfc7523',
    ]),
    {
      idp: true,
      as: true,
      mcp: true,
      portBase: 4100,
      host: '::1',
      cors: 'http://localhost:5173',
      clientAuth: 'private_key_jwt',
      assertionProfile: 'rfc7523',
      help: false,
    },
  )
  assert.equal(parseCliArgs(['--help']).help, true)
})

test('cli args: a typo, a missing value or a host that is not loopback stops it', () => {
  assert.throws(() => parseCliArgs(['--idps']), /unknown option "--idps"/)
  assert.throws(() => parseCliArgs(['--port-base']), /--port-base needs a value/)
  assert.throws(() => parseCliArgs(['--cors', '--mcp']), /--cors needs a value/)
  assert.throws(() => parseCliArgs(['--port-base', 'abc']), /--port-base must be/)
  assert.throws(() => parseCliArgs(['--port-base', '65535']), /--port-base must be/)
  assert.throws(() => parseCliArgs(['--client-auth', 'none']), /--client-auth must be/)
  assert.throws(() => parseCliArgs(['--assertion-profile', 'bis']), /--assertion-profile must be/)
  for (const host of ['0.0.0.0', 'localhost', '192.168.0.2']) {
    assert.throws(() => parseCliArgs(['--host', host]), /loopback only/, host)
  }
})

// ── started as functions ──────────────────────────────────────────────────

test('cli: only the servers that were named are started, wired to each other', async () => {
  const mcpOnly = await startFromCli(parseCliArgs(['--mcp']))
  try {
    assert.deepEqual(Object.keys(mcpOnly.info), ['mcp'])
    assert.equal(mcpOnly.info.mcp?.requireAuth, false)
    assert.equal(
      (await getJson(`${mcpOnly.mcp?.origin}/.well-known/oauth-protected-resource`)).status,
      200,
    )
  } finally {
    await mcpOnly.close()
  }
  // Without an IdP the authorization server is the interactive one.
  const noIdp = await startFromCli(parseCliArgs(['--as', '--mcp']))
  try {
    assert.equal(noIdp.info.as?.mode, 'interactive')
    assert.equal(noIdp.info.as?.clientSecret, undefined)
    assert.equal(noIdp.info.mcp?.requireAuth, true)
    const meta = await getJson(`${noIdp.mcp?.origin}/.well-known/oauth-protected-resource/mcp`)
    assert.deepEqual(meta.body.authorization_servers, [noIdp.info.as?.issuer])
    const registered = await fetch(`${noIdp.info.as?.issuer}/register`, {
      method: 'POST',
      body: '{}',
    })
    assert.equal(registered.status, 201)
  } finally {
    await noIdp.close()
  }
})

test('cli: --port-base puts the three servers on consecutive ports', async () => {
  // A port that was free a moment ago; try again if the next two are not.
  for (let attempt = 0; ; attempt += 1) {
    const probe = await startLocalMcpServer()
    const base = Number(new URL(probe.url).port)
    await probe.close()
    if (base > 65000) continue
    let servers
    try {
      servers = await startFromCli(parseCliArgs(['--port-base', String(base)]))
    } catch (err) {
      if (attempt < 5 && /EADDRINUSE/.test(String(err))) continue
      throw err
    }
    try {
      assert.equal(servers.info.idp?.issuer, `http://127.0.0.1:${base}`)
      assert.equal(servers.info.as?.issuer, `http://127.0.0.1:${base + 1}`)
      assert.equal(servers.info.mcp?.url, `http://127.0.0.1:${base + 2}/mcp`)
    } finally {
      await servers.close()
    }
    // A taken port fails the start and leaves nothing behind.
    const blocker = await startLocalMcpServer({ port: base + 1 })
    try {
      await assert.rejects(
        () => startFromCli(parseCliArgs(['--port-base', String(base)])),
        /EADDRINUSE/,
      )
      await assert.rejects(() => fetch(`http://127.0.0.1:${base}/`), 'the IdP was closed again')
    } finally {
      await blocker.close()
    }
    return
  }
})

// ── started as a process ──────────────────────────────────────────────────

interface IRunning {
  child: ChildProcess
  /** The JSON line. */
  info: Record<string, Record<string, unknown>> & { cors?: string }
  /** Everything printed on stdout. */
  stdout: () => string
  stop: () => Promise<number | null>
}

const run = (args: string[]): Promise<IRunning> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CLI, ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)))
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()))
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      const newline = out.indexOf('\n')
      if (newline === -1) return
      try {
        resolve({
          child,
          info: JSON.parse(out.slice(0, newline)) as IRunning['info'],
          stdout: () => out,
          stop: () => {
            child.kill('SIGTERM')
            return exited
          },
        })
      } catch (cause) {
        child.kill('SIGKILL')
        reject(new Error(`the first line is not JSON: ${out}`, { cause }))
      }
    })
    void exited.then((code) => reject(new Error(`exited ${code} before printing: ${err}`)))
  })

const exitOf = (args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CLI, ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    // A run that should have refused and is serving instead is stopped, not waited for.
    const stuck = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.once('exit', (code) => {
      clearTimeout(stuck)
      resolve({ code, stdout, stderr })
    })
  })

const echoThrough = async (url: string, token: string): Promise<string> => {
  const client = new Client({ name: 'cli-test', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  const result = await client.callTool({ name: 'echo', arguments: { text: 'from the cli' } })
  await client.close()
  return (result as { content: { text: string }[] }).content[0].text
}

test('cli process: one JSON line with URLs and generated credentials that work end to end', async () => {
  const running = await run([
    '--idp',
    '--as',
    '--mcp',
    '--port-base',
    '0',
    '--cors',
    'http://localhost:5173',
  ])
  try {
    const { idp, as, mcp } = running.info
    // One line, and nothing else, on stdout.
    assert.equal(running.stdout().trim().split('\n').length, 1)
    assert.equal(running.info.cors, 'http://localhost:5173')
    for (const url of [idp.issuer, as.issuer, mcp.url]) {
      assert.match(String(url), /^http:\/\/127\.0\.0\.1:\d+/)
    }
    assert.equal(as.mode, 'enterprise')
    assert.equal(idp.clientAuthMethod, 'client_secret_basic')
    assert.equal(mcp.requireAuth, true)
    for (const secret of [idp.clientSecret, as.clientSecret]) {
      assert.match(String(secret), /^[A-Za-z0-9_-]{32}$/, 'a secret made up at start')
    }
    assert.notEqual(idp.clientSecret, as.clientSecret)

    // The whole enterprise flow, from another process, with what was printed.
    const idToken = (await getJson(String(idp.idTokenEndpoint))).body.id_token
    const exchanged = await postForm(
      String(idp.tokenEndpoint),
      exchangeParams(String(idToken), String(as.issuer), { resource: String(mcp.url) }),
      basic(String(idp.clientId), String(idp.clientSecret)),
    )
    assert.equal(exchanged.status, 200)
    const granted = await postForm(
      String(as.tokenEndpoint),
      grantParams(String(exchanged.body.access_token)),
      basic(String(as.clientId), String(as.clientSecret)),
    )
    assert.equal(granted.status, 200)
    assert.equal(
      await echoThrough(String(mcp.url), String(granted.body.access_token)),
      'echo:from the cli',
    )
    // --cors reached all three.
    for (const url of [idp.tokenEndpoint, as.tokenEndpoint, mcp.url]) {
      const res = await fetch(String(url), { method: 'OPTIONS' })
      assert.equal(res.status, 204)
      assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173')
    }
  } finally {
    assert.equal(await running.stop(), 0, 'SIGTERM is a clean exit')
  }
  await assert.rejects(() => fetch(String(running.info.mcp.url)), 'nothing is left listening')
})

test('cli process: a new set of credentials every start', async () => {
  const [a, b] = await Promise.all([run(['--idp']), run(['--idp'])])
  try {
    assert.notEqual(a.info.idp.clientSecret, b.info.idp.clientSecret)
    assert.equal(a.info.as, undefined)
    assert.equal(a.info.mcp, undefined)
  } finally {
    await a.stop()
    await b.stop()
  }
})

test('cli process: --client-auth private_key_jwt prints keys that authenticate, in the profile asked for', async () => {
  const running = await run(['--client-auth', 'private_key_jwt', '--assertion-profile', 'rfc7523'])
  try {
    const { idp, as, mcp } = running.info
    assert.equal(idp.clientAuthMethod, 'private_key_jwt')
    assert.equal(idp.assertionProfile, 'rfc7523')
    assert.equal(idp.clientSecret, undefined)
    assert.equal(as.algorithm, 'ES256')
    const assertion = (client: Record<string, unknown>, audience: unknown, typ: string) => {
      const now = Math.floor(Date.now() / 1000)
      return {
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: signJwt(
          createPrivateKey({ key: client.privateJwk as JsonWebKey, format: 'jwk' }),
          { typ, kid: client.keyId },
          {
            iss: client.clientId,
            sub: client.clientId,
            aud: audience,
            jti: `${now}-${Math.random()}`,
            iat: now,
            exp: now + 60,
          },
        ),
      }
    }
    const idToken = String((await getJson(String(idp.idTokenEndpoint))).body.id_token)
    // The bis form is not what these servers were started to accept.
    const bis = await postForm(String(idp.tokenEndpoint), {
      ...exchangeParams(idToken, String(as.issuer)),
      ...assertion(idp, idp.issuer, 'client-authentication+jwt'),
    })
    assert.equal(bis.status, 401)
    const exchanged = await postForm(String(idp.tokenEndpoint), {
      ...exchangeParams(idToken, String(as.issuer)),
      ...assertion(idp, idp.tokenEndpoint, 'JWT'),
    })
    assert.equal(exchanged.status, 200)
    const granted = await postForm(String(as.tokenEndpoint), {
      ...grantParams(String(exchanged.body.access_token)),
      ...assertion(as, as.tokenEndpoint, 'JWT'),
    })
    assert.equal(granted.status, 200)
    assert.equal(
      await echoThrough(String(mcp.url), String(granted.body.access_token)),
      'echo:from the cli',
    )
  } finally {
    await running.stop()
  }
})

test('cli process: --help prints the usage; a bad flag or host exits 2 and starts nothing', async () => {
  const help = await exitOf(['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /--port-base <n>/)
  assert.match(help.stdout, /For tests only/)
  const typo = await exitOf(['--idpp'])
  assert.equal(typo.code, 2)
  assert.equal(typo.stdout, '')
  assert.match(typo.stderr, /unknown option "--idpp"/)
  const host = await exitOf(['--host', '0.0.0.0'])
  assert.equal(host.code, 2)
  assert.equal(host.stdout, '', 'no JSON line: nothing was started')
  assert.match(host.stderr, /loopback only/)
})
