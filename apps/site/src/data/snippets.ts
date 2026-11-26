// The quick starts of the three READMEs, shortened. Keep them runnable: they are what a visitor
// copies first.
export const SNIPPETS = [
  {
    id: 'node',
    label: 'Node',
    lang: 'ts',
    code: `import { createAgent } from '@dudko.dev/agent'

const agent = await createAgent({
  clientName: 'my-app',
  providerType: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4.1-mini',
  mcpServers: {
    docs: { url: 'https://mcp.example.com/mcp' },
  },
})

const result = await agent.run({
  input: 'Find the latest pricing page and summarize the tiers.',
})

console.log(result.text)
await agent.close()`,
  },
  {
    id: 'browser',
    label: 'Browser',
    lang: 'ts',
    code: `import { createAgent, defineTool, VaultCredentialStore } from '@dudko.dev/agent-web'
import { z } from 'zod'

// The user's own key, encrypted at rest (WebCrypto + IndexedDB).
const credentials = new VaultCredentialStore()
await credentials.setApiKey('openai', userProvidedKey)

const agent = await createAgent({
  model: { providerType: 'openai', model: 'gpt-4o-mini', credentialRef: 'openai' },
  credentials,
  tools: {
    add_text: defineTool({
      description: 'Add a text block to the page.',
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => addTextBlock(text), // your code
    }),
  },
})

const result = await agent.run('Add a centered title and a totals line', {
  onEvent: (e) => e.type === 'step.tool-call' && console.log(e.name, e.input),
})`,
  },
  {
    id: 'react',
    label: 'React',
    lang: 'tsx',
    code: `import { AgentProvider, AgentChat, useCredentials } from '@dudko.dev/agent-web-react'
import '@dudko.dev/agent-web-react/styles.css'

export function Assistant() {
  const credentials = useCredentials() // the encrypted vault

  return (
    <AgentProvider
      config={{
        model: { providerType: 'google', model: 'gemini-3.5-flash', credentialRef: 'google' },
        credentials: credentials.store,
        tools, // your app's actions, as tools
      }}
    >
      <AgentChat title="Assistant" style={{ height: 520 }} />
    </AgentProvider>
  )
}`,
  },
] as const
