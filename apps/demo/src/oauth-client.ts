// The demo's OAuth client for MCP servers that ask for one.
//
// On https://agent.dudko.dev the demo is a client with a fixed identity: its client ID is the
// address of a client ID metadata document (CIMD) the site serves, apps/site/public/oauth/client.json,
// which names the demo's pages as its redirect addresses. An authorization server that advertises
// `client_id_metadata_document_supported` fetches that document and registers nothing; one that
// does not gets a dynamic registration (DCR), as before.
//
// Anywhere else (a Cloudflare preview, `vite dev`, the browser tests) the page's address is not in
// that document, so the demo registers itself (DCR) - which is also what the browser tests drive.

export const DEMO_CLIENT_METADATA_URL = 'https://agent.dudko.dev/oauth/client.json'
const DEMO_ORIGIN = 'https://agent.dudko.dev'

/** The CIMD URL for a page at `where`, or nothing when that page cannot use it. */
export const demoClientMetadataUrl = (
  where: { origin: string } | undefined = globalThis.location,
): string | undefined => (where?.origin === DEMO_ORIGIN ? DEMO_CLIENT_METADATA_URL : undefined)
