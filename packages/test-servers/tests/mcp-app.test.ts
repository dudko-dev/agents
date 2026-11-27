import assert from 'node:assert/strict'
import test from 'node:test'
import {
  startLocalMcpServer,
  TRAVEL_APP_URI,
  TRAVEL_BAD_APP_URI,
  TRAVEL_CHECKOUT_URL,
  TRAVEL_FLIGHTS,
  travelAppHtml,
} from '../src/index.ts'
import { initialize, legacy, modern } from './mcp-wire.ts'

// The MCP Apps tools (`appTools`), on the wire with hand-built JSON-RPC, in both eras: the tools'
// `_meta.ui`, the app resource and its metadata, and every fault switch of `appFaults`.

const APPS = 'io.modelcontextprotocol/ui'
const MIME = 'text/html;profile=mcp-app'
type Era = 'legacy' | 'modern'

/** One request in the era's own form; resolves with the JSON-RPC result. */
const rpc = async (
  era: Era,
  url: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<any> => {
  const answer =
    era === 'modern'
      ? await modern(url, method, params, {
          capabilities: { extensions: { [APPS]: {} } },
          // 2026-07-28: a resource read names its URI in Mcp-Name.
          ...(typeof params.uri === 'string' ? { headers: { 'mcp-name': params.uri } } : {}),
        })
      : await legacy(url, { jsonrpc: '2.0', id: 1, method, params })
  assert.equal(answer.message?.error, undefined, `${method}: ${answer.text}`)
  return answer.message.result
}

for (const era of ['legacy', 'modern'] as Era[]) {
  test(`apps (${era}): the tools declare their app and who may call them`, async () => {
    const mcp = await startLocalMcpServer({ protocol: era, appTools: true })
    try {
      if (era === 'legacy')
        await initialize(mcp.url, { extensions: { [APPS]: { mimeTypes: [MIME] } } })
      const { tools } = await rpc(era, mcp.url, 'tools/list')
      const byName = new Map<string, any>(tools.map((t: any) => [t.name, t]))
      assert.deepEqual(byName.get('flights.search')._meta, { ui: { resourceUri: TRAVEL_APP_URI } })
      assert.equal(byName.get('flights.search').annotations.readOnlyHint, true)
      assert.deepEqual(byName.get('flights.book')._meta.ui.visibility, ['model', 'app'])
      assert.deepEqual(byName.get('flights.refresh')._meta.ui.visibility, ['app'])
      assert.deepEqual(byName.get('flights.admin')._meta, { ui: { visibility: ['model'] } })
      assert.equal(byName.get('flights.bad')._meta.ui.resourceUri, TRAVEL_BAD_APP_URI)
      // The plain tools are unchanged beside them.
      assert.equal(byName.get('echo')._meta, undefined)

      const found = await rpc(era, mcp.url, 'tools/call', {
        name: 'flights.search',
        arguments: { from: 'LIS', to: 'VIE' },
      })
      assert.deepEqual(found.structuredContent, {
        route: { from: 'LIS', to: 'VIE', date: '2026-12-12' },
        flights: TRAVEL_FLIGHTS,
      })
      assert.match(found.content[0].text, /^Three flights LIS → VIE: SL 418 07:40 €129/)
      const booked = await rpc(era, mcp.url, 'tools/call', {
        name: 'flights.book',
        arguments: { flight: 'SL 418' },
      })
      assert.equal(booked.content[0].text, 'booked:SL 418')
      assert.deepEqual(
        mcp.calls.map((c) => c.name),
        ['flights.search', 'flights.book'],
      )
    } finally {
      await mcp.close()
    }
  })

  test(`apps (${era}): the app resource - its HTML, MIME type and metadata`, async () => {
    const mcp = await startLocalMcpServer({
      protocol: era,
      appTools: {
        connectDomains: ['http://127.0.0.1:9'],
        declaredUrl: 'http://127.0.0.1:9/ok',
        undeclaredUrl: 'http://127.0.0.1:8/no',
      },
    })
    try {
      if (era === 'legacy') await initialize(mcp.url)
      const read = await rpc(era, mcp.url, 'resources/read', { uri: TRAVEL_APP_URI })
      assert.equal(read.contents.length, 1)
      const [app] = read.contents
      assert.equal(app.uri, TRAVEL_APP_URI)
      assert.equal(app.mimeType, MIME)
      assert.match(app.text, /^<!doctype html>/)
      assert.ok(app.text.includes(JSON.stringify(TRAVEL_CHECKOUT_URL)))
      assert.ok(app.text.includes('"http://127.0.0.1:8/no"'), 'the undeclared URL is in the probes')
      assert.deepEqual(app._meta.ui, {
        csp: { connectDomains: ['http://127.0.0.1:9'], resourceDomains: [] },
        permissions: { camera: {} },
        prefersBorder: true,
      })
      const bad = await rpc(era, mcp.url, 'resources/read', { uri: TRAVEL_BAD_APP_URI })
      assert.equal(bad.contents[0].mimeType, 'text/html')

      // Every fault, one at a time.
      mcp.appFaults.mime = 'text/html'
      assert.equal(
        (await rpc(era, mcp.url, 'resources/read', { uri: TRAVEL_APP_URI })).contents[0].mimeType,
        'text/html',
      )
      mcp.appFaults.mime = undefined
      mcp.appFaults.padTo = 50_000
      assert.equal(
        (await rpc(era, mcp.url, 'resources/read', { uri: TRAVEL_APP_URI })).contents[0].text
          .length,
        50_000,
      )
      mcp.appFaults.padTo = undefined
      mcp.appFaults.otherUri = true
      assert.equal(
        (await rpc(era, mcp.url, 'resources/read', { uri: TRAVEL_APP_URI })).contents[0].uri,
        'ui://travel/other.html',
      )
      mcp.appFaults.otherUri = false
      mcp.appFaults.cspInjection = true
      const injected = (await rpc(era, mcp.url, 'resources/read', { uri: TRAVEL_APP_URI }))
        .contents[0]
      assert.ok(injected._meta.ui.csp.connectDomains.includes('https://ok.example; script-src *'))
    } finally {
      await mcp.close()
    }
  })
}

test('apps: off by default - no flights tools, no resources', async () => {
  const mcp = await startLocalMcpServer()
  try {
    await initialize(mcp.url)
    const { tools } = await rpc('legacy', mcp.url, 'tools/list')
    assert.deepEqual(tools.map((t: any) => t.name).sort(), ['boom', 'echo', 'secret'])
    const answer = await legacy(mcp.url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: { uri: TRAVEL_APP_URI },
    })
    assert.ok(answer.message.error, 'a server without resources refuses the read')
  } finally {
    await mcp.close()
  }
})

test('apps: the app document - replaced whole by `html`, URLs embedded as JSON', () => {
  assert.equal(travelAppHtml({ html: '<p>mine</p>' }), '<p>mine</p>')
  const doc = travelAppHtml({ undeclaredUrl: 'http://x.test/</script><script>alert(1)</script>' })
  assert.ok(!doc.includes('</script><script>alert(1)'), 'a URL cannot close the script')
})
