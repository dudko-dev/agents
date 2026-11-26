import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BrowserAgentConfig, ModelInput } from '@dudko.dev/agent-web'
import { createFileTools, type AgentToolSet } from '@dudko.dev/agent-web-react'
import { useMcpServers } from '@dudko.dev/agent-web-react/mcp'
import {
  nodeResolver,
  PipelineEditor,
  usePipeline,
  type PipelineDefinition,
  type PipelineNode,
  type PipelineOption,
} from '@dudko.dev/agent-web-react/pipeline'
import { buildCloudModel } from '../cloud'
import { McpPanel } from '../components/McpPanel'
import { Settings } from '../components/Settings'
import { DEMO_URL } from '../links'
import { Markdown } from '../markdown'
import markUrl from '../mark.svg'
import { isLocal, MODELS } from '../models'
import { allSkills, useDemoSettings, useSettingsConfig } from '../settings'
import { GPU_LOST, GPU_LOST_NOTICE, useDemoModel } from '../use-model'
import { workspace } from '../workspace'
import { EXAMPLES, STARTER } from './examples'

// The pipeline editor as a page of its own, at /pipeline/. It is the same origin as the demo,
// and it uses the demo's own modules for everything they share: the chosen model and its key
// (use-model.ts, the vault), the model list, the Settings and MCP panels, the connected MCP
// servers (useMcpServers' list in localStorage), the skills and the workspace.

const KEY = 'agent-web-demo:pipeline'
const MINE_KEY = 'agent-web-demo:pipeline:mine'

const read = (key: string): PipelineDefinition | undefined => {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as PipelineDefinition | null
    if (value && Array.isArray(value.nodes) && Array.isArray(value.edges)) return value
  } catch {
    /* private mode, or not JSON */
  }
  return undefined
}
const write = (key: string, definition: PipelineDefinition) => {
  try {
    localStorage.setItem(key, JSON.stringify(definition))
  } catch {
    /* private mode */
  }
}

const same = (a: PipelineDefinition, b: PipelineDefinition) =>
  JSON.stringify(a) === JSON.stringify(b)
/** Which example the definition is, untouched; `mine` when it is the visitor's own. */
const exampleOf = (definition: PipelineDefinition): string =>
  EXAMPLES.find((e) => same(e.definition, definition))?.id ?? 'mine'

const NO_MODEL =
  'No model yet: pick one in the Model panel and add its key (or load a local model).'

export const PipelineApp = () => {
  const {
    setModelId,
    model,
    local,
    customModelId,
    setCustomModelId,
    credentials,
    localModel,
    resolvedModel,
    modelWindow,
  } = useDemoModel()
  // The limits, thinking and web access set in the demo's "Agent settings" apply here too.
  const { settings } = useDemoSettings()
  const { config: settingsConfig } = useSettingsConfig(settings, modelWindow)

  // ── The definition: autosaved, with the visitor's own kept apart from the examples ──
  const [definition, setDefinition] = useState<PipelineDefinition>(
    () => read(KEY) ?? STARTER.definition,
  )
  const [fitKey, setFitKey] = useState(0)
  const [input, setInput] = useState(
    () => EXAMPLES.find((e) => same(e.definition, read(KEY) ?? STARTER.definition))?.request ?? '',
  )
  const choice = exampleOf(definition)
  const [hasMine, setHasMine] = useState(() => read(MINE_KEY) !== undefined)
  // Dragging a node changes the definition on every frame; the disk hears about it once.
  useEffect(() => {
    const timer = setTimeout(() => write(KEY, definition), 250)
    return () => clearTimeout(timer)
  }, [definition])
  // A reload right after an edit must not lose it.
  const latest = useRef(definition)
  latest.current = definition
  useEffect(() => {
    const flush = () => write(KEY, latest.current)
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [])

  // ── What a node may name ───────────────────────────────────────────────────
  // Models: every cloud model whose key is in the vault (a node on the default model needs no
  // entry here). Which keys exist is asked of the vault, never read.
  const [keyed, setKeyed] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    let active = true
    const refs = [...new Set(MODELS.flatMap((m) => (m.credentialRef ? [m.credentialRef] : [])))]
    void Promise.all(
      refs.map((ref) =>
        credentials.store
          .getApiKey(ref)
          .then((key) => (key ? ref : undefined))
          .catch(() => undefined),
      ),
    ).then((found) => {
      if (active) setKeyed(new Set(found.filter((r): r is string => Boolean(r))))
    })
    return () => {
      active = false
    }
  }, [credentials.store, credentials.version])
  const modelOptions = useMemo<PipelineOption[]>(
    () =>
      MODELS.filter(
        (m) => !isLocal(m) && !m.customModel && m.credentialRef && keyed.has(m.credentialRef),
      ).map((m) => ({ id: m.id, label: `${m.group}: ${m.label.split(' — ')[0]}` })),
    [keyed],
  )

  const skills = useMemo(
    () => allSkills(settings),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.customSkills],
  )
  const skillRegistry = useMemo(() => Object.fromEntries(skills.map((s) => [s.name, s])), [skills])
  const fileTools = useMemo(() => createFileTools(workspace), [])
  const toolRegistry = useMemo<Record<string, AgentToolSet>>(
    () => ({ files: fileTools }),
    [fileTools],
  )

  // The servers connected in the demo are connected here: the list is in localStorage.
  const mcp = useMcpServers({ clientName: 'agent-web-demo' })
  const connected = mcp.servers.filter((s) => s.status === 'connected')
  const connectedKey = connected.map((s) => s.name).join('|')
  const mcpRegistry = useMemo(
    () =>
      Object.fromEntries(
        connectedKey
          .split('|')
          .filter(Boolean)
          .map((name) => [
            name,
            {
              tools: Object.fromEntries(
                Object.entries(mcp.tools).filter(([tool]) => tool.startsWith(`${name}__`)),
              ) as AgentToolSet,
            },
          ]),
      ),
    [connectedKey, mcp.tools],
  )

  // ── From a node to its agent ───────────────────────────────────────────────
  const base = useMemo<BrowserAgentConfig>(
    () => ({
      model: resolvedModel as ModelInput,
      credentials: credentials.store,
      ...settingsConfig,
      // Nobody is asked here: the tools a node can name are the workspace and the visitor's own
      // MCP servers, chosen node by node in the inspector.
      toolApproval: { mode: 'autopilot' },
      ...(model.vision ? { vision: true } : {}),
    }),
    [resolvedModel, credentials.store, settingsConfig, model.vision],
  )
  const resolveNode = useCallback(
    async (node: PipelineNode) => {
      const models: Record<string, ModelInput> = {}
      if (node.model !== undefined) {
        // A node that names a model: built from the vault's key when the node first runs.
        const option = MODELS.find((m) => m.id === node.model)
        if (!option?.provider || !option.credentialRef) {
          throw new Error(`"${node.model}" is not a model this page can build`)
        }
        const key = await credentials.store.getApiKey(option.credentialRef)
        if (!key) throw new Error(`No ${option.keyLabel ?? 'key'} stored for ${option.label}`)
        models[node.model] = await buildCloudModel(option.provider, option.model, key)
      } else if (!resolvedModel) {
        throw new Error(NO_MODEL)
      }
      return nodeResolver({
        base,
        models,
        skills: skillRegistry,
        tools: toolRegistry,
        mcpServers: mcpRegistry,
      })(node)
    },
    [base, resolvedModel, credentials.store, skillRegistry, toolRegistry, mcpRegistry],
  )
  const pipeline = usePipeline(definition, { resolveNode })

  // A local model the GPU dropped is not "loaded", whatever the page remembers.
  const [gpuLost, setGpuLost] = useState(false)
  const unloadLocal = localModel.unload
  useEffect(() => {
    if (!local || !pipeline.error || !GPU_LOST.test(pipeline.error)) return
    setGpuLost(true)
    void unloadLocal()
  }, [local, pipeline.error, unloadLocal])
  useEffect(() => {
    if (localModel.loading) setGpuLost(false)
  }, [localModel.loading])

  // ── Examples ───────────────────────────────────────────────────────────────
  const resetRun = pipeline.reset
  const load = (id: string) => {
    if (id === choice || pipeline.isRunning) return
    // The visitor's own pipeline is put aside, not thrown away.
    if (choice === 'mine') {
      write(MINE_KEY, definition)
      setHasMine(true)
    }
    const example = EXAMPLES.find((e) => e.id === id)
    const next = example?.definition ?? read(MINE_KEY)
    if (!next) return
    setDefinition(next)
    setInput(example?.request ?? '')
    setFitKey((n) => n + 1)
    resetRun()
  }

  const options = useMemo(
    () => ({
      skills: skills.map((s) => ({ id: s.name, description: s.description })),
      tools: [
        {
          id: 'files',
          label: 'Workspace files',
          description: 'Read and write the files of the workspace (fs_* tools).',
        },
      ],
      mcpServers: connectedKey
        .split('|')
        .filter(Boolean)
        .map((name) => ({ id: name })),
    }),
    [skills, connectedKey],
  )
  const ready = Boolean(resolvedModel)

  return (
    <div className="app pl">
      <header className="app__header">
        <a className="app__brand" href="/" aria-label="dudko.dev agents: home">
          <img className="app__logo" src={markUrl} alt="" width="28" height="28" />
          <span className="app__name">agents</span>
          <span className="app__badge">pipeline</span>
        </a>

        <label className="pl__examples">
          <span className="pl__examples-label">Example</span>
          <select
            className="pl__examples-select"
            value={choice}
            disabled={pipeline.isRunning}
            onChange={(e) => load(e.target.value)}
          >
            {EXAMPLES.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
            {(choice === 'mine' || hasMine) && <option value="mine">Your pipeline</option>}
          </select>
        </label>

        <nav className="app__links" aria-label="Project">
          <a href={DEMO_URL}>Demo</a>
          <a href="/docs/react/pipeline/">Docs</a>
          <a href="https://github.com/dudko-dev/agents" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>
      </header>

      <h1 className="app__sr">
        Pipeline editor: draw a graph of LLM agents on a canvas, connect them with conditions and
        loops, and run it in your browser
      </h1>

      <main className="pl__main">
        <div className="pl__setup">
          <Settings
            models={MODELS}
            selected={model}
            onSelect={setModelId}
            credentials={credentials}
            local={localModel}
            notice={gpuLost ? GPU_LOST_NOTICE : undefined}
            customModelId={customModelId}
            onCustomModelId={setCustomModelId}
            onKeyChange={() => {}}
            ready={ready}
          />
          <details className="settings pl__mcp">
            <summary className="settings__summary">
              <span className="settings__summary-title">MCP servers</span>
              <span className={`settings__summary-status${connected.length ? ' is-ok' : ''}`}>
                {connected.length ? `${connected.length} connected` : 'none connected'}
              </span>
            </summary>
            <p className="settings__note">
              A node uses a server once you tick it in the node&rsquo;s inspector. Servers connected
              in the demo are connected here too.
            </p>
            <McpPanel mcp={mcp} toolCount={Object.keys(mcp.tools).length} searchMode={false} />
          </details>
        </div>

        <div className="pl__editor">
          <PipelineEditor
            value={definition}
            onChange={setDefinition}
            controller={pipeline}
            models={modelOptions}
            skills={options.skills}
            tools={options.tools}
            mcpServers={options.mcpServers}
            input={input}
            onInputChange={setInput}
            fitKey={fitKey}
            theme="dark"
            renderContent={(text) => <Markdown text={text} />}
          />
        </div>
      </main>
    </div>
  )
}
