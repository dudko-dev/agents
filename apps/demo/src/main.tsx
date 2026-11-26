import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@dudko.dev/agent-web-react/styles.css'
import './app.css'
import { App } from './App'
import { reloadOnStaleChunks } from './stale-chunks'

// A tab left open across a deploy: see stale-chunks.ts (shared with the pipeline page).
reloadOnStaleChunks()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
