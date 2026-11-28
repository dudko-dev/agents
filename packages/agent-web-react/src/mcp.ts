// The MCP half of the bindings, behind its own subpath: `@dudko.dev/agent-web-react/mcp`.
//
// WHY THIS IS NOT IN THE MAIN ENTRY. `useMcp` loads the core's `./mcp` subpath with a dynamic
// `import()`, and that was meant to keep `@modelcontextprotocol/client` — an optional peer — out of
// the way of hosts that never use MCP. It does at RUNTIME. A bundler does not run anything: for a
// dynamic import it must resolve the target at build time to emit a chunk, and the core's `mcp.js`
// imports the SDK statically (and re-exports `UnauthorizedError` by identity, so that cannot be
// made lazy). So a host that merely imported `useAgent` from the main entry got
// "Module not found: @modelcontextprotocol/client" from webpack, with MCP nowhere in its code.
//
// A subpath moves the decision to the host, where it belongs: import from here and the SDK is
// needed (and bundled); never import from here and no part of the build ever mentions it. This is
// the same rule the core follows for its own `./mcp`.
export {
  useMcp,
  claimOAuthCallback,
  describeMcpResult,
  isUnauthorizedError,
  mcpAppsRouter,
  mcpInstructionsOf,
  mcpOAuthOptionsOfRecord,
  mcpOAuthProviderOptions,
  mcpOAuthRecordOf,
  mcpOAuthRegistrationOf,
  mcpProtocolOf,
  mcpSkillsSettingOf,
  newMcpOAuthProvider,
  readCallbackParams,
  stripOAuthParams,
} from './hooks/use-mcp.js'
export type {
  McpConnectOptions,
  McpElicitationControls,
  McpOAuthOptions,
  McpOAuthRecord,
  McpSkillsSetting,
  McpStatus,
  UseMcpOptions,
  UseMcpReturn,
} from './hooks/use-mcp.js'
export { useMcpServers } from './hooks/use-mcp-servers.js'
export type {
  McpAuthMode,
  McpServerSpec,
  McpServerView,
  UseMcpServersOptions,
  UseMcpServersReturn,
} from './hooks/use-mcp-servers.js'
// The queue behind `pendingElicitations` / `answerElicitation`, for a host that calls the core's
// `connectMcpHttp` itself. (`<ElicitationPrompt>` and the form helpers are in the main entry.)
export {
  createElicitationQueue,
  elicitationConnectOptions,
  elicitationSettings,
  elicitationTimeoutOf,
} from './elicitation.js'
export type {
  ElicitationQueue,
  ElicitationQueueOptions,
  PendingElicitation,
} from './elicitation.js'
export type {
  BrowserOAuthProvider,
  BrowserOAuthProviderOptions,
  ConnectedMcp,
  McpCatalogEntry,
  McpElicitationFieldSchema,
  McpElicitationHandler,
  McpElicitationOptions,
  McpElicitationRequest,
  McpElicitationResult,
  McpElicitationSchema,
  McpOAuthCallback,
  McpOAuthRegistration,
  McpOAuthRegistrationKind,
  McpProtocolMode,
  McpServerInstructions,
  McpServerProtocol,
  McpServerResult,
  McpModule,
} from './mcp-types.js'
