export { connectMcpHttp, diagnoseMcpCors, flattenContent } from './http.js'
// Re-exported so a host that only depends on this package can identify an
// authorization failure: `err instanceof UnauthorizedError`. The 2.x SDK's
// class is branded, so the check also holds for an error made by ANOTHER copy
// of the SDK (two bundles, or the ESM and the CJS build on one page), and it
// sets `name` to 'UnauthorizedError' (the 1.x class did neither).
export { UnauthorizedError } from '@modelcontextprotocol/client'
export {
  MCP_INSTRUCTIONS_MAX_CHARS_PER_SERVER,
  MCP_INSTRUCTIONS_MAX_CHARS_TOTAL,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_MODERN_REQUEST_HEADERS,
  renderMcpInstructions,
} from './shared.js'
export type { McpProtocolMode, McpServerInstructions, McpServerProtocol } from './shared.js'
export {
  MCP_ELICITATION_MAX_PER_RUN,
  MCP_ELICITATION_MAX_PER_TOOL_CALL,
  MCP_ELICITATION_TIMEOUT_MS,
  normalizeMcpElicitationSchema,
  validateMcpElicitationContent,
} from './elicitation.js'
export type {
  McpElicitationContent,
  McpElicitationContext,
  McpElicitationFieldSchema,
  McpElicitationHandler,
  McpElicitationOptions,
  McpElicitationReason,
  McpElicitationRequest,
  McpElicitationResult,
  McpElicitationSchema,
} from './elicitation.js'
export type {
  McpHttpServerConfig,
  McpCatalogEntry,
  McpServerResult,
  ConnectedMcp,
  ConnectMcpOptions,
} from './http.js'
export {
  BrowserOAuthProvider,
  MemoryOAuthStorage,
  VaultOAuthStorage,
  beginMcpOAuth,
  checkAuthorizationResponseIssuer,
  finishMcpOAuth,
  readOAuthCallback,
} from './oauth.js'
export type {
  BrowserOAuthProviderOptions,
  McpOAuthCallback,
  McpOAuthRequestOptions,
  McpOAuthStorage,
} from './oauth.js'
export {
  BrowserEnterpriseOAuthProvider,
  createEnterpriseOAuthProvider,
  ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION,
  EnterpriseOAuthError,
} from './enterprise-oauth.js'
export type {
  EnterpriseAssertionAlgorithm,
  EnterpriseAssertionAudience,
  EnterpriseAssertionType,
  EnterpriseIdpOptions,
  EnterpriseOAuthHop,
  EnterpriseOAuthLog,
  EnterpriseOAuthProviderOptions,
  EnterprisePrivateKey,
} from './enterprise-oauth.js'
