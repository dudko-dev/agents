#!/usr/bin/env node
// A minimal MCP stdio server that also writes lines to stdout that are not
// JSON-RPC (a banner, a debug line) - what a server started through a dev
// runner does. `env` answers with the environment variables it was asked for.
// Used by tests/mcp-protocol.test.ts.

import { createInterface } from 'node:readline'

process.stdout.write('chatty-mcp starting...\n')

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
      result: { tools: [{ name: 'env', inputSchema: { type: 'object' } }] },
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
      result: { content: [{ type: 'text', text: JSON.stringify(picked) }] },
    })
    return
  }
  send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } })
})

rl.on('close', () => process.exit(0))
