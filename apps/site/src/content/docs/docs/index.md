---
title: Overview
description: What the three dudko.dev agent packages are, how they relate, and which one to start with.
---

Three npm packages share one planning loop: **plan → execute → replan → answer**. The planner
turns a request into ordered steps, the executor runs each step by calling tools, the replanner
decides after a step whether to continue, revise the plan or stop, and the synthesizer writes
the answer.

## Which package

| You are building | Start with | It gives you |
| --- | --- | --- |
| A server, a job or a CLI in Node | [`@dudko.dev/agent`](/docs/node/) | stdio and HTTP MCP servers, OAuth 2.1, a REPL CLI, persistence and resume, OpenTelemetry, a safe fetch |
| An agent inside a web page, with no backend | [`@dudko.dev/agent-web`](/docs/browser/) | bring-your-own-key cloud models or local WebGPU models, an encrypted key vault, HTTP MCP, a virtual file system |
| A React app | [`@dudko.dev/agent-web-react`](/docs/react/) | the `useAgent` hook, a provider and a drop-in chat over the browser agent |

The Node and the browser agent are siblings, not layers: neither depends on the other. They keep
the same config field names, event names and semantics, so what you learn in one applies to the
other. The React package is a layer over the browser agent and has no agent logic of its own.

## Install

```bash
npm install @dudko.dev/agent                                # Node
npm install @dudko.dev/agent-web ai zod                     # browser
npm install @dudko.dev/agent-web-react @dudko.dev/agent-web # React
```

Model providers are optional peer dependencies: install only the ones you use, for example
`@ai-sdk/openai` or `@ai-sdk/anthropic`.

## Where to read next

- **[Capabilities](/docs/browser/capabilities/)** — thinking, token limits, compaction, skills, tool
  consent, large MCP catalogues, subagents, steering a run, learning, web access, and the full
  event reference. Written for the browser agent; the Node agent's page covers the same ground
  for the server.
- **[Providers](/docs/browser/providers/)** — every model provider, and which ones a browser may
  call directly.
- **[Security](/docs/browser/security/)** — what the key vault, the web fetch tool and the learning
  notebook protect, and what they do not.
- **[Chat components](/docs/react/chat/)** — the drop-in chat and every part of it.
- **[Live demo](/demo/)** — the React package running in your browser, with your own key or a
  local model.

## Status

The packages are pre-1.0 (`0.0.x`): the API can change between releases. They are MIT licensed
and developed in one repository, [`dudko-dev/agents`](https://github.com/dudko-dev/agents).
