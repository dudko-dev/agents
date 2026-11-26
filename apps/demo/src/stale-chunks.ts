// A tab left open across a deploy still holds the old page, and the chunks that page names are
// gone: a lazy import (a local model's runtime, the MCP connector) then fails - Safari says
// "Importing a module script failed". The fix is the new page, so load it; once per session, so
// a chunk that is really broken does not reload in a loop.
const RELOADED = 'demo:reloaded-for-chunks'

export const reloadOnStaleChunks = () => {
  window.addEventListener('vite:preloadError', (event) => {
    let already = false
    try {
      already = sessionStorage.getItem(RELOADED) === '1'
      sessionStorage.setItem(RELOADED, '1')
    } catch {
      already = true // no storage, no way to tell a loop from a first try: let the error show
    }
    if (already) return
    event.preventDefault()
    window.location.reload()
  })
}
