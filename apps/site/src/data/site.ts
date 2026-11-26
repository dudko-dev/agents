import agent from '../../../../packages/agent/package.json'
import agentWeb from '../../../../packages/agent-web/package.json'
import agentWebReact from '../../../../packages/agent-web-react/package.json'

export const SITE = 'https://agent.dudko.dev'
export const REPO = 'https://github.com/dudko-dev/agents'
export const TITLE = 'Planning AI agents for Node and the browser'
export const DESCRIPTION =
  'Open-source TypeScript agents that plan, call MCP tools, replan and answer. One loop for Node servers and for the browser, with React bindings and a live demo.'

/** The three packages, with the versions in this repository (so the page cannot state a stale one). */
export const PACKAGES = [
  {
    name: agent.name,
    version: agent.version,
    where: 'Node / server',
    summary:
      'The planning loop over stdio and HTTP MCP servers, with OAuth 2.1, a REPL CLI, persistence and resume, OpenTelemetry and a safe fetch.',
    install: `npm install ${agent.name}`,
    docs: '/docs/node/',
  },
  {
    name: agentWeb.name,
    version: agentWeb.version,
    where: 'Browser',
    summary:
      'The same loop with no server: bring-your-own-key cloud models or local WebGPU models, an encrypted key vault, HTTP MCP and a virtual file system.',
    install: `npm install ${agentWeb.name} ai zod`,
    docs: '/docs/browser/',
  },
  {
    name: agentWebReact.name,
    version: agentWebReact.version,
    where: 'React',
    summary:
      'A useAgent hook, a provider and a drop-in chat: transcript with every tool call, consent prompts, attachments, saved chats and a workspace.',
    install: `npm install ${agentWebReact.name} ${agentWeb.name}`,
    docs: '/docs/react/',
  },
] as const
