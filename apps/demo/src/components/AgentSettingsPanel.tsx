import { useState, type ReactNode } from 'react'
import {
  ApiKeyForm,
  ApprovalModeSwitch,
  LearnedSkills,
  loadSkillFromUrl,
  parseSkillMarkdown,
  type UseAgentReturn,
  type UseCredentialsReturn,
} from '@dudko.dev/agent-web-react'
import {
  allSkills,
  DEFAULT_WINDOW,
  parseHosts,
  SEARCH_CREDENTIAL,
  skillsOfView,
  TIER_AUTO,
  type DemoSettings,
  type ThinkingChoice,
  type View,
} from '../settings'
import { BUILTIN_SKILLS, SKILL_TEMPLATE } from '../skills'
import type { ModelOption } from '../models'
import { DECISION_SPEC, MEDIA_MODELS, type MediaProvider } from '../use-extras'
import { autoTiers, TIER_MODELS } from '../use-model'

export interface AgentSettingsPanelProps {
  settings: DemoSettings
  /** The open tab: its skills are listed, and the notes speak about its tools. */
  view: View
  /** The open tab's agent: its notebook is listed under "Learning". */
  controller?: UseAgentReturn
  /** The model's own window, when known ("auto" uses it). */
  modelWindow?: number
  /** Tier models that are chosen but have no key saved yet (they stay off until it is). */
  tiersMissingKey?: { tier: 'light' | 'strong'; model: ModelOption }[]
  /** The key vault: the search API's key is saved there, like a model's. */
  credentials: UseCredentialsReturn
  /** The chosen model: "auto" tiers and the "which key is missing" notes are about it. */
  model: ModelOption
  /** Which keys are in the vault (undefined while it is being asked). */
  savedKeys?: ReadonlySet<string>
  /** Whose media models are in use; undefined = media is not in effect. */
  mediaProvider?: MediaProvider
  /** The decision model is built and in the agents' config. */
  decisionOn?: boolean
  /** Which tier models are built and in the agents' config. */
  tiersOn?: { light: boolean; strong: boolean }
  /** After a key is saved or removed here: rebuild the agents. */
  onKeyChange?: () => void
  update: (patch: Partial<DemoSettings>) => void
  onReset: () => void
}

const TOKEN_BUDGETS = [0, 20_000, 50_000, 100_000, 250_000]
const TOOL_CALL_CAPS = [0, 5, 10, 25, 50]
const WINDOWS = [4_096, 8_000, 32_000, 128_000, 1_000_000]
// 4096 → 4k, 32768 → 32k, 128000 → 128k.
const k = (n: number) =>
  n >= 1_000_000 ? `${n / 1_000_000}M` : `${n % 1024 === 0 ? n / 1024 : Math.round(n / 1000)}k`

/** "on" / "off: why" next to a switch: what is in effect, not what is ticked. */
const State = ({ on, children }: { on: boolean; children: ReactNode }) => (
  <span className={`agentset__state${on ? ' is-on' : children === 'off' ? ' is-off' : ''}`}>
    {children}
  </span>
)

/** One capability: its switch, its state, and (below) whatever it needs. */
const Cap = ({
  title,
  checked,
  onChange,
  label,
  on,
  state,
  children,
}: {
  title: string
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  on: boolean
  state: string
  children?: ReactNode
}) => (
  <li className="agentset__cap">
    <div className="agentset__cap-row">
      <label title={title}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />{' '}
        {label}
      </label>
      <State on={on}>{state}</State>
    </div>
    {children}
  </li>
)

const short = (m: ModelOption) => m.label.split(' — ')[0]

/**
 * Everything the agent loop exposes, as settings: tool consent (the autopilot
 * switch), what the agent can do (every capability is on by default; the ones
 * that need a key say whether they are in effect), model tiers, thinking, run
 * limits, context compaction and skills. The loop settings are shared by all
 * three tabs; the skills shown are the open tab's.
 */
export const AgentSettingsPanel = ({
  settings,
  view,
  controller,
  modelWindow,
  tiersMissingKey = [],
  credentials,
  model,
  savedKeys,
  mediaProvider,
  decisionOn = false,
  tiersOn = { light: false, strong: false },
  onKeyChange,
  update,
  onReset,
}: AgentSettingsPanelProps) => {
  const skills = skillsOfView(settings, view)
  const enabledHere = skills.filter((s) => settings.enabledSkills.includes(s.name)).length
  const writeExample =
    view === 'chess' ? 'a chess move' : view === 'mcp' ? 'a write to your MCP server' : 'a note'
  const [draft, setDraft] = useState('')
  const [skillUrl, setSkillUrl] = useState('')
  const [skillError, setSkillError] = useState<string | undefined>()
  const builtin = new Set(BUILTIN_SKILLS.map((s) => s.name))

  // ── what is in effect (not merely ticked) ──────────────────────────────────
  const has = (ref: string) => Boolean(savedKeys?.has(ref))
  const checking = savedKeys === undefined
  const searchOn = settings.search && has(SEARCH_CREDENTIAL)
  const mediaOn = settings.media && mediaProvider !== undefined
  const mediaLabel = mediaProvider ? MEDIA_MODELS[mediaProvider].label : ''
  const hosts = parseHosts(settings.egressAllow)
  const auto = autoTiers(model)
  const tierOn = tiersOn.light || tiersOn.strong
  // A Google key serves media and the decision model. When the chosen model is Google's, its key
  // is the one in the Model panel above; otherwise it is asked for here.
  const needsGoogleKey =
    !checking &&
    !has(DECISION_SPEC.credentialRef) &&
    ((settings.media && !mediaOn) || settings.decision)
  const googleKeyHere = needsGoogleKey && model.credentialRef !== DECISION_SPEC.credentialRef
  const missing = (what: string) => (checking ? 'checking…' : `off: needs ${what}`)

  // What the agent may do without asking, in the consent mode it is in.
  const can = [
    settings.learning && 'write lessons into its notebook',
    settings.egress &&
      `read the web (${hosts.length ? `${hosts.length} allowed host${hosts.length === 1 ? '' : 's'}` : 'ANY public https host'})`,
    searchOn && 'search the web with your Tavily key',
    settings.sandbox && 'run code it wrote, in a sandbox',
    settings.helpers && 'start helper agents',
    mediaOn &&
      `generate images and speech and transcribe audio, billed to your ${mediaLabel} key (8 media calls a run at most)`,
  ].filter((x): x is string => Boolean(x))

  const tierState = (tier: 'light' | 'strong'): { on: boolean; text: string } => {
    const setting = tier === 'light' ? settings.tierLight : settings.tierStrong
    if (!setting) return { on: false, text: 'off' }
    const chosen = setting === TIER_AUTO ? auto[tier] : TIER_MODELS.find((m) => m.id === setting)
    if (!chosen) {
      return {
        on: false,
        text:
          model.rank === undefined
            ? 'off: no auto tier for this model'
            : `off: no ${tier === 'light' ? 'lighter' : 'stronger'} model of this provider`,
      }
    }
    if (tiersOn[tier]) return { on: true, text: `on: ${short(chosen)}` }
    return { on: false, text: missing(`a ${chosen.keyLabel ?? 'key'}`) }
  }

  const toggleSkill = (name: string, on: boolean) =>
    update({
      enabledSkills: on
        ? [...settings.enabledSkills, name]
        : settings.enabledSkills.filter((n) => n !== name),
    })

  const addSkill = (skill: ReturnType<typeof parseSkillMarkdown>) => {
    if (allSkills(settings).some((s) => s.name === skill.name)) {
      throw new Error(`a skill named "${skill.name}" already exists`)
    }
    update({
      customSkills: [...settings.customSkills, skill],
      enabledSkills: [...settings.enabledSkills, skill.name],
    })
  }

  const addFromDraft = () => {
    try {
      addSkill(parseSkillMarkdown(draft))
      setDraft('')
      setSkillError(undefined)
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : String(err))
    }
  }

  const addFromUrl = async () => {
    try {
      addSkill(await loadSkillFromUrl(skillUrl.trim()))
      setSkillUrl('')
      setSkillError(undefined)
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <details className="agentset">
      <summary className="agentset__title">
        Agent settings{' '}
        <span className="agentset__peek">
          {settings.approvalMode === 'autopilot' ? 'autopilot' : settings.approvalMode} · thinking{' '}
          {settings.thinking} · {enabledHere} skill(s)
        </span>
      </summary>

      <div className="agentset__group">
        <span className="settings__label">Tool consent</span>
        <ApprovalModeSwitch
          mode={settings.approvalMode}
          onChange={(approvalMode) => update({ approvalMode })}
        />
        <p className="settings__note">
          {settings.approvalMode === 'autopilot'
            ? 'Autopilot: the agent runs every tool on its own.'
            : settings.approvalMode === 'ask-writes'
              ? `Read-only tools run freely; you approve anything that changes state (${writeExample}).`
              : settings.approvalMode === 'ask-all'
                ? 'You approve every single tool call.'
                : 'Read-only: changes are refused without asking — the agent can only look.'}{' '}
          Switches apply instantly, even mid-run.
        </p>
        <p className="settings__note agentset__can">
          {can.length === 0
            ? 'Beyond this tab’s own tools the agent has nothing switched on.'
            : `${
                settings.approvalMode === 'autopilot'
                  ? 'Besides this tab’s own tools, without asking it may'
                  : 'Besides this tab’s own tools it has, under the consent mode above, the means to'
              }: ${can.join('; ')}. Each is a switch below.`}
        </p>
      </div>

      <div className="agentset__group">
        <span className="settings__label">What the agent can do — all on by default</span>
        <ul className="agentset__caps">
          <Cap
            label="Let the agent learn (save lessons as skills)"
            title="On by default in this demo (off in the library). The agent keeps a notebook: when it solves a problem it writes the lesson down as a skill of its own, and the planner sees it from then on. You can read, edit and delete the files in the Files panel (/skills)."
            checked={settings.learning}
            onChange={(learning) => update({ learning })}
            on={settings.learning}
            state={settings.learning ? 'on' : 'off'}
          >
            {settings.learning && (
              <LearnedSkills controller={controller} showSources className="agentset__notebook" />
            )}
          </Cap>
          <Cap
            label="Let it read the web (web_fetch)"
            title="On by default in this demo (off in the library), limited to the hosts below. Off, the agent has no way to make a request of its own. On, it gets one tool, web_fetch."
            checked={settings.egress}
            onChange={(egress) => update({ egress })}
            on={settings.egress}
            state={
              settings.egress
                ? hosts.length
                  ? `on: ${hosts.length} host${hosts.length === 1 ? '' : 's'}`
                  : 'on: any host'
                : 'off'
            }
          >
            {settings.egress && (
              <label className="settings__field">
                <span className="settings__label">Allowed hosts</span>
                <input
                  className="settings__select"
                  type="text"
                  value={settings.egressAllow}
                  placeholder="en.wikipedia.org, *.github.com"
                  onChange={(e) => update({ egressAllow: e.target.value })}
                />
                <span className="settings__note">
                  Comma-separated; <code>*.host</code> covers subdomains. Empty = any public https
                  host — risky in a browser, which cannot pin DNS; keep a list. Only sites that
                  allow cross-origin reads (CORS) answer at all; for the rest hand{' '}
                  <code>egress.fetch</code> a gateway.
                </span>
              </label>
            )}
          </Cap>
          <Cap
            label="Let it run code (run_js, sandboxed)"
            title="On by default in this demo (off in the library). Off, the model can only describe what its code would print. On, it gets one tool, run_js: the code runs in an isolated JavaScript engine (QuickJS in WebAssembly) inside a Web Worker - no page, no network, limited time and memory - and can read and write the workspace files the agent itself may. The engine is downloaded the first time code runs."
            checked={settings.sandbox}
            onChange={(sandbox) => update({ sandbox })}
            on={settings.sandbox}
            state={settings.sandbox ? 'on' : 'off'}
          />
          <Cap
            label="Let it start helpers (spawn_subagent)"
            title="On by default in this demo (off in the library). Off, the tool does not exist. On, the model gets spawn_subagent: for an independent sub-task it starts a helper agent of its own, built from this agent's models and a subset of its tools, under the same consent mode and inside this run's budget. Each helper shows in the chat as a node of a tree, with a Stop button."
            checked={settings.helpers}
            onChange={(helpers) => update({ helpers })}
            on={settings.helpers}
            state={settings.helpers ? 'on' : 'off'}
          />
          <Cap
            label="Let it search the web (web_search)"
            title="On when a Tavily key is saved: the library ships no search engine and no key. With one, the model gets web_search, which asks Tavily - the hosted search API that answers a page directly - with your own key. Results are third-party text: the chat shows them as plain text. Without a key the tool is not offered to the model."
            checked={settings.search}
            onChange={(search) => update({ search })}
            on={searchOn}
            state={!settings.search ? 'off' : searchOn ? 'on: Tavily' : missing('a Tavily key')}
          >
            {settings.search && (
              <div className="settings__field">
                <ApiKeyForm
                  credentials={credentials}
                  credentialRef={SEARCH_CREDENTIAL}
                  label="Tavily API key"
                  placeholder="tvly-…"
                  onChange={onKeyChange}
                />
                <span className="settings__note">
                  Tavily is a web search service made for AI agents (it has a free tier). The agent
                  needs some search service to search the web, and this demo uses Tavily. The key is
                  stored encrypted in this browser, next to the model keys, and sent only to
                  api.tavily.com.{' '}
                  <a href="https://app.tavily.com" target="_blank" rel="noopener noreferrer">
                    Get a key →
                  </a>
                </span>
              </div>
            )}
          </Cap>
          <Cap
            label="Let it make images and speech, and hear audio (media)"
            title="On when a Google or an OpenAI key is saved. The model gets generate_image, generate_speech and transcribe_audio, and an audio file you attach is transcribed before the model reads it. Generated files are written to the workspace (/media) and shown in the answer; the bytes never go to the language model. Every call is billed to your key by the provider; a run makes 8 media calls at most."
            checked={settings.media}
            onChange={(media) => update({ media })}
            on={mediaOn}
            state={
              !settings.media
                ? 'off'
                : mediaOn
                  ? `on: ${mediaLabel}`
                  : missing('a Google or OpenAI key')
            }
          >
            {mediaOn && (
              <span className="settings__note">
                {mediaProvider === 'google' ? (
                  <>
                    Image <code>{MEDIA_MODELS.google.image}</code> (Google gives image models no
                    free quota: on a free-tier key the tool answers with Google’s quota error),
                    speech <code>{MEDIA_MODELS.google.speech}</code>, transcription{' '}
                    <code>{MEDIA_MODELS.google.transcription}</code>.
                  </>
                ) : (
                  <>
                    Image <code>{MEDIA_MODELS.openai.image}</code>, speech{' '}
                    <code>{MEDIA_MODELS.openai.speech}</code>, transcription{' '}
                    <code>{MEDIA_MODELS.openai.transcription}</code>. Whether OpenAI’s media
                    endpoints answer a browser page directly has not been checked: if they do not,
                    the tool says so.
                  </>
                )}
              </span>
            )}
          </Cap>
          <Cap
            label="Use a decision model (gemini-decision-1)"
            title="On when a Google key is saved. When a step fails or reports a blocker, the loop asks whether to carry on, finish or revise the plan. With this on, the question goes first to Google's small decision model: it answers with one option and a probability, in a fraction of the time. Its answer is used only when the probability is at least 0.8; otherwise - and whenever a new plan is needed - the ordinary replanner call runs as ever. The chat says which happened. On the pipeline page it also picks a node's route. Never used for consent or web access."
            checked={settings.decision}
            onChange={(decision) => update({ decision })}
            on={decisionOn}
            state={!settings.decision ? 'off' : decisionOn ? 'on: Google' : missing('a Google key')}
          />
        </ul>
        {needsGoogleKey &&
          (googleKeyHere ? (
            <div className="settings__field agentset__key">
              <ApiKeyForm
                credentials={credentials}
                credentialRef={DECISION_SPEC.credentialRef}
                label="Google AI Studio key (media, decision model)"
                placeholder="AIza…"
                onChange={onKeyChange}
              />
              <span className="settings__note">
                Stored encrypted in this browser, sent only to Google.{' '}
                <a
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Get a key →
                </a>
              </span>
            </div>
          ) : (
            <p className="settings__note agentset__key">
              To switch these on, save your Google AI Studio key in the Model panel above.
            </p>
          ))}
      </div>

      <div className="agentset__group">
        <span className="settings__label">Model tiers</span>
        <div className="agentset__grid agentset__grid--two">
          {(
            [
              ['tierLight', 'Light model', 'light'],
              ['tierStrong', 'Strong model', 'strong'],
            ] as const
          ).map(([key, label, tier]) => {
            const state = tierState(tier)
            return (
              <div key={key} className="settings__field">
                <label className="settings__field">
                  <span className="settings__label">{label}</span>
                  <select
                    className="settings__select"
                    value={settings[key]}
                    onChange={(e) => update({ [key]: e.target.value })}
                  >
                    <option value={TIER_AUTO}>
                      auto ({auto[tier] ? short(auto[tier]) : 'none here'})
                    </option>
                    <option value="">none</option>
                    {TIER_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.group} · {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                <State on={state.on}>{state.text}</State>
              </div>
            )
          })}
        </div>
        <p className="settings__note">
          {tierOn
            ? 'The planner rates each step: easy ones run on the light model, hard ones on the strong one (it costs more per token), the rest on the model chosen above. A step that fails is retried once on the next stronger model.'
            : 'Off: every step runs on the model chosen above.'}{' '}
          {(settings.tierLight === TIER_AUTO || settings.tierStrong === TIER_AUTO) &&
            'Auto picks the lightest and the strongest model of the chosen model’s own provider, on the same key.'}
        </p>
        {/* A tier of the chosen model's own provider waits for the key of the Model panel. */}
        {tiersMissingKey
          .filter(({ model: m }) => m.credentialRef !== model.credentialRef)
          .map(({ tier, model: m }) => (
            <p key={tier} className="settings__warn">
              The {tier} model is off: no {m.keyLabel ?? 'key'} saved yet. To use it, choose a model
              of {m.group} above, save its key, then switch back.
            </p>
          ))}
      </div>

      <div className="agentset__group">
        <span className="settings__label">The loop</span>
        <div className="agentset__grid">
          <label className="settings__field">
            <span className="settings__label">Thinking</span>
            <select
              className="settings__select"
              value={settings.thinking}
              onChange={(e) => update({ thinking: e.target.value as ThinkingChoice })}
            >
              <option value="off">default</option>
              <option value="none">none</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>
          <label className="settings__field">
            <span className="settings__label">Tokens / run</span>
            <select
              className="settings__select"
              value={settings.maxTotalTokens}
              onChange={(e) => update({ maxTotalTokens: Number(e.target.value) })}
            >
              {TOKEN_BUDGETS.map((n) => (
                <option key={n} value={n}>
                  {n ? k(n) : 'unlimited'}
                </option>
              ))}
            </select>
          </label>
          <label className="settings__field">
            <span className="settings__label">Tool calls / run</span>
            <select
              className="settings__select"
              value={settings.maxToolCalls}
              onChange={(e) => update({ maxToolCalls: Number(e.target.value) })}
            >
              {TOOL_CALL_CAPS.map((n) => (
                <option key={n} value={n}>
                  {n || 'unlimited'}
                </option>
              ))}
            </select>
          </label>
          <label className="settings__field">
            <span className="settings__label">Steps / run</span>
            <input
              className="settings__select"
              type="number"
              min={1}
              max={20}
              value={settings.maxIterations}
              onChange={(e) => update({ maxIterations: Math.max(1, Number(e.target.value) || 1) })}
            />
          </label>
          <label className="settings__field">
            <span className="settings__label">Rounds / step</span>
            <input
              className="settings__select"
              type="number"
              min={1}
              max={12}
              value={settings.maxStepsPerTask}
              onChange={(e) =>
                update({ maxStepsPerTask: Math.max(1, Number(e.target.value) || 1) })
              }
            />
          </label>
          <label className="settings__field">
            <span className="settings__label">Window</span>
            <select
              className="settings__select"
              value={settings.contextWindowTokens}
              onChange={(e) => update({ contextWindowTokens: Number(e.target.value) })}
            >
              <option value={0}>auto ({k(modelWindow ?? DEFAULT_WINDOW)})</option>
              {WINDOWS.map((n) => (
                <option key={n} value={n}>
                  {k(n)}
                  {modelWindow && n > modelWindow ? ' (capped at the model’s)' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="agentset__checks">
          <label title="On by default: when the conversation nears the window (85% of it, counting the prompt, the tools and the skills), older turns are summarised so the run goes on.">
            <input
              type="checkbox"
              checked={settings.autoCompact}
              onChange={(e) => update({ autoCompact: e.target.checked })}
            />{' '}
            Auto-compact the conversation
          </label>
          <label title="Off by default, and the one switch that takes capabilities away: no replanning and no separate final answer (so no decision model either) - 2 model calls per turn instead of 3+. The biggest speed-up on a local model, together with Thinking “none”.">
            <input
              type="checkbox"
              checked={settings.fastAnswers}
              onChange={(e) => update({ fastAnswers: e.target.checked })}
            />{' '}
            Fast answers (fewer model calls)
          </label>
        </div>
      </div>

      <div className="agentset__group">
        <span className="settings__label">Chat UI — every part is a prop</span>
        <div className="agentset__checks">
          {(
            [
              ['showThoughts', 'Thoughts'],
              ['showToolCalls', 'Tool calls'],
              ['showUsage', 'Token usage'],
              ['history', 'Saved chats (IndexedDB)'],
              ['filesPanel', 'Files panel'],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={settings[key]}
                onChange={(e) => update({ [key]: e.target.checked })}
              />{' '}
              {label}
            </label>
          ))}
        </div>
        <div className="agentset__grid">
          <label className="settings__field">
            <span className="settings__label">Chat language</span>
            <select
              className="settings__select"
              value={settings.lang}
              onChange={(e) => update({ lang: e.target.value as DemoSettings['lang'] })}
            >
              <option value="en">English</option>
              <option value="es">Español</option>
              <option value="de">Deutsch</option>
            </select>
          </label>
        </div>
      </div>

      <div className="agentset__group">
        <span className="settings__label">Skills</span>
        <ul className="agentset__skills">
          {skills.map((s) => (
            <li key={s.name}>
              <label title={s.content}>
                <input
                  type="checkbox"
                  checked={settings.enabledSkills.includes(s.name)}
                  onChange={(e) => toggleSkill(s.name, e.target.checked)}
                />{' '}
                <code>{s.name}</code> — {s.description}
              </label>
              {!builtin.has(s.name) && (
                <button
                  type="button"
                  className="mcp__btn-ghost"
                  onClick={() =>
                    update({
                      customSkills: settings.customSkills.filter((c) => c.name !== s.name),
                      enabledSkills: settings.enabledSkills.filter((n) => n !== s.name),
                    })
                  }
                >
                  remove
                </button>
              )}
            </li>
          ))}
        </ul>
        <details className="agentset__add">
          <summary>Add a skill (SKILL.md)</summary>
          <textarea
            className="agentset__textarea"
            rows={7}
            placeholder={SKILL_TEMPLATE}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="mcp__actions">
            <button
              type="button"
              className="settings__btn"
              onClick={addFromDraft}
              disabled={!draft.trim()}
            >
              Add
            </button>
            <button
              type="button"
              className="mcp__btn-ghost"
              onClick={() => setDraft(SKILL_TEMPLATE)}
            >
              Insert template
            </button>
          </div>
          <div className="mcp__form-row">
            <input
              className="mcp__input mcp__grow"
              type="url"
              placeholder="…or import https://…/SKILL.md"
              value={skillUrl}
              onChange={(e) => setSkillUrl(e.target.value)}
            />
            <button
              type="button"
              className="settings__btn"
              onClick={() => void addFromUrl()}
              disabled={!skillUrl.trim()}
            >
              Import
            </button>
          </div>
        </details>
        {skillError && <p className="settings__warn">{skillError}</p>}
      </div>

      <button type="button" className="mcp__btn-ghost" onClick={onReset}>
        Reset settings
      </button>
    </details>
  )
}
