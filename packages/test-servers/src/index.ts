/**
 * Test servers for the agent packages. Loopback only, keys generated at start,
 * switches that make each one misbehave. Never run them where anything but a
 * test can reach them.
 */
export {
  applyCors,
  assertLoopbackHost,
  closeServer,
  CORS_ALLOW_HEADERS,
  CORS_ALLOW_HEADERS_2025,
  corsHeaders,
  listen,
  type IListenOptions,
} from './http.ts'
export {
  CLIENT_ASSERTION_TYPE,
  CLIENT_AUTHENTICATION_TYP,
  generateClientKey,
  ID_JAG_TOKEN_TYPE,
  ID_JAG_TYP,
  ID_TOKEN_TOKEN_TYPE,
  JWT_BEARER_GRANT,
  peekJwt,
  readClientAuth,
  signJwt,
  TOKEN_EXCHANGE_GRANT,
  verifyClientAssertion,
  verifyJwt,
  type ClientAssertionProfile,
  type IClientKey,
  type IVerifiedJwt,
} from './jwt.ts'
export {
  startLocalIdp,
  type IIdpExchange,
  type IIdpMisbehaviour,
  type ILocalIdp,
  type ILocalIdpOptions,
} from './idp-server.ts'
export {
  startLocalAuthorizationServer,
  type IEnterpriseGrantOptions,
  type ILocalAuthorizationServer,
  type ILocalAuthorizationServerOptions,
  type ITokenRequest,
} from './authorization-server.ts'
export {
  ELICIT_FORM_SCHEMA,
  validFormContent,
  type ElicitationRequest,
  type IElicitationFaults,
  type IElicitationRound,
  type IUrlElicitation,
} from './mcp-elicitation.ts'
export {
  REPORT_IMAGE_BASE64,
  REPORT_VALUE,
  startLocalMcp,
  startLocalMcpServer,
  type ILocalMcp,
  type ILocalMcpOptions,
  type ILocalMcpServer,
  type ILocalMcpServerOptions,
  type IMcpRequestRecord,
  type McpProtocol,
  type ProbeFault,
  type StructuredFault,
} from './mcp-server.ts'
export { parseCliArgs, startFromCli, type ICliArgs, type ICliServers } from './cli.ts'
