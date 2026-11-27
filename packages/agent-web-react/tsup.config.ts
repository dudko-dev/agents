import { copyFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

// React, react-dom and the core agent are peers — never bundled. Consumers
// bring their own React and install @dudko.dev/agent-web (which in turn
// dynamically imports only the model providers it needs).
const EXTERNAL = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  '@dudko.dev/agent-web',
  '@dudko.dev/agent-web/mcp',
  'ai',
  'zod',
]

export default defineConfig({
  // `mcp` is its own entry so that nothing in `index` can pull the core's MCP connector (and with
  // it the optional MCP SDK) into a host's build — see src/mcp.ts.
  // `pipeline` is its own entry too: the editor (a canvas, an inspector, a code generator) is not
  // something a chat should carry, and it needs a core that has `createPipeline` - see
  // src/pipeline.ts.
  // `mcp-app-sandbox` is the sandbox proxy page for a SERVER (a Worker, Node): no React, no core,
  // no import at all - see src/mcp-app-sandbox.ts.
  entry: {
    index: 'src/index.ts',
    mcp: 'src/mcp.ts',
    pipeline: 'src/pipeline.ts',
    'mcp-app-sandbox': 'src/mcp-app-sandbox.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  external: EXTERNAL,
  esbuildOptions(options) {
    // Emit the classic-free automatic JSX runtime so the bundle never assumes a
    // global `React` in scope.
    options.jsx = 'automatic'
  },
  // The stylesheets are optional and framework-agnostic; ship them verbatim next to
  // the JS so hosts can `import '@dudko.dev/agent-web-react/styles.css'` (the chat) and
  // `'@dudko.dev/agent-web-react/pipeline.css'` (the pipeline editor; it stands on its own).
  onSuccess: async () => {
    copyFileSync('src/styles.css', 'dist/styles.css')
    copyFileSync('src/pipeline.css', 'dist/pipeline.css')
  },
})
