#!/usr/bin/env node
// A minimal MCP stdio server that also writes lines to stdout that are not
// JSON-RPC (a banner, a debug line) - what a server started through a dev
// runner does. `env` answers with the environment variables it was asked for.
// Used by tests/mcp-protocol.test.ts.
//
// It speaks the 2025 revisions: `server/discover` is answered "method not
// found". Three switches, for the `protocol` option of a stdio server:
// - CHATTY_STARTS=<file>: append a line per process started (the version probe
//   of 'auto' / 'modern' runs on a second process).
// - CHATTY_DISCOVER=silent: never answer `server/discover` (a 2025 server may
//   ignore a request it does not know before `initialize`).
// - CHATTY_DISCOVER=modern: answer it with 2026-07-28 and serve that revision
//   (hand-written from the specification: no SDK server is involved here).

import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

process.stdout.write('chatty-mcp starting...\n')
if (process.env.CHATTY_STARTS) {
  appendFileSync(process.env.CHATTY_STARTS, 'start\n')
}
const DISCOVER = process.env.CHATTY_DISCOVER
const modern = DISCOVER === 'modern'
const complete = modern ? { resultType: 'complete' } : {}

const rl = createInterface({ input: process.stdin })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

rl.on('line', (line) => {
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  if (req.id === undefined) {
    return
  }
  if (req.method === 'server/discover' && DISCOVER === 'silent') {
    return
  }
  if (req.method === 'server/discover' && modern) {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        resultType: 'complete',
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        instructions: 'chatty, the modern way',
        ttlMs: 0,
        cacheScope: 'private',
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'chatty-mcp', version: '0.0.1' } },
      },
    })
    return
  }
  if (req.method === 'initialize' && modern) {
    send({
      jsonrpc: '2.0',
      id: req.id,
      error: {
        code: -32022,
        message: 'Unsupported protocol version',
        data: { supported: ['2026-07-28'], requested: req.params?.protocolVersion },
      },
    })
    return
  }
  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'chatty-mcp', version: '0.0.1' },
      },
    })
    return
  }
  if (req.method === 'tools/list') {
    process.stdout.write('[debug] listing tools\n')
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        ...complete,
        ...(modern ? { ttlMs: 0, cacheScope: 'private' } : {}),
        tools: [{ name: 'env', inputSchema: { type: 'object' } }],
      },
    })
    return
  }
  if (req.method === 'tools/call') {
    process.stdout.write('[debug] calling\n')
    const names = req.params?.arguments?.names ?? []
    const picked = Object.fromEntries(names.map((n) => [n, process.env[n] ?? null]))
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: { ...complete, content: [{ type: 'text', text: JSON.stringify(picked) }] },
    })
    return
  }
  send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } })
})

rl.on('close', () => process.exit(0))
