import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@dudko.dev/agent-web-react/styles.css'
import './app.css'
import { App } from './App'

// A tab left open across a deploy still holds the old page, and the chunks that page names are
// gone: a lazy import (a local model's runtime, the MCP connector) then fails - Safari says
// "Importing a module script failed". The fix is the new page, so load it; once per session, so
// a chunk that is really broken does not reload in a loop.
const RELOADED = 'demo:reloaded-for-chunks'
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
