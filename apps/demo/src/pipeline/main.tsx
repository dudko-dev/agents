import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// The chat stylesheet too: the Settings panel this page shares with the demo draws the package's
// ApiKeyForm and ModelLoadBar.
import '@dudko.dev/agent-web-react/styles.css'
import '@dudko.dev/agent-web-react/pipeline.css'
import '../app.css'
import './pipeline.css'
import { reloadOnStaleChunks } from '../stale-chunks'
import { PipelineApp } from './PipelineApp'

reloadOnStaleChunks()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PipelineApp />
  </StrictMode>,
)
