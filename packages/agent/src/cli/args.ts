import { parseArgs } from 'node:util'

export interface ICliArgs {
  envFile?: string
  help: boolean
  // Optional one-shot overrides for the most common env vars. They are applied
  // to process.env before loadConfig() runs, so flags win over an .env file
  // and over the ambient process env.
  overrides: Record<string, string>
}

export const HELP = `Usage: dd-agent [options]

Options:
  --env-file=<path>             Load env vars from a dotenv file before starting
  --provider=<type>             AGENT_PROVIDER_TYPE (see "Required env vars" below for the full list)
  --model=<id>                  AGENT_MODEL
  --planner-model=<id>          AGENT_PLANNER_MODEL
  --synthesizer-model=<id>      AGENT_SYNTHESIZER_MODEL
  --base-url=<url>              AGENT_BASE_URL
  --log-level=<level>           AGENT_LOG_LEVEL (none|error|warn|info|debug)
  --max-iterations=<n>          AGENT_MAX_ITERATIONS
  --max-steps-per-task=<n>      AGENT_MAX_STEPS_PER_TASK
  --tool-strategy=<v>           AGENT_TOOL_SELECTION_STRATEGY (auto|all|plan-narrowed|search)
  -h, --help                    Show this help

API keys are still read from env (AGENT_API_KEY etc.) - we deliberately do
not accept them as flags so they don't end up in shell history.

Required env vars (set directly or via --env-file):
  AGENT_PROVIDER_TYPE   openai | anthropic | google | openai-compatible | xai | azure |
                        amazon-bedrock | google-vertex | deepseek | gateway | cloudflare
  AGENT_API_KEY         provider API key
  AGENT_MODEL           model id
  MCP_SERVERS           JSON: { "<name>": { "url": "...", "headers"?: {...} } | { "command": "...", "args"?: [], "env"?: {} } }
                        each entry may add "protocol": "legacy" (default) | "auto" | "modern" (the MCP revision: 2026-07-28 when offered / only)

Optional env vars (see env.example for the full list):
  AGENT_EXECUTOR_LIGHT_MODEL  a cheaper executor model for steps the planner rates "low"
  AGENT_EXECUTOR_STRONG_MODEL a stronger executor model for steps it rates "high" (AGENT_MODEL runs the rest);
                              each takes _PROVIDER_TYPE / _BASE_URL / _API_KEY / _PROVIDER_OPTIONS like the planner
  AGENT_ESCALATION            off keeps a failed step on its tier (default with tier models: retry it on a stronger one)
  AGENT_ESCALATION_MAX_PER_STEP / _PER_RUN  caps on those retries (default 1 / 3)
  AGENT_THINKING              off | minimal | low | medium | high | xhigh | <budget tokens>
  AGENT_MAX_INPUT_TOKENS      per-run caps; crossing one jumps to the final answer
  AGENT_MAX_OUTPUT_TOKENS
  AGENT_MAX_REASONING_TOKENS
  AGENT_MAX_TOTAL_TOKENS
  AGENT_MAX_TOOL_CALLS        cap on tool calls per run
  AGENT_PER_CALL_TOKENS       JSON: per-stage output cap per LLM call, e.g. {"executor":16000,"synthesizer":0}
                              (default: a share of the context window; 0 = no cap)
  AGENT_TOOL_APPROVAL         autopilot | ask-writes | ask-all | read-only
  AGENT_TOOL_RULES            JSON: { "<tool or glob*>": "allow" | "ask" | "deny" } - beats the mode
  AGENT_MCP_ELICITATION       form lets an MCP server ask YOU something during a tool call (a form at the
                              prompt); all also accepts a link to open yourself; off (default): servers cannot ask
  AGENT_SKILLS_DIR            folder of <skill>/SKILL.md skills
  AGENT_LEARNING              on lets the agent write down lessons as skills (for this session)
  AGENT_LEARNING_DIR          keep them as <dir>/<name>/SKILL.md across sessions (needs AGENT_LEARNING=on)
  AGENT_EGRESS                on lets the model read the web (web_fetch); off (default) = no outbound requests
  AGENT_EGRESS_ALLOW / _DENY  comma lists: host, *.host, IP or CIDR (deny wins; allow limits to these)
  AGENT_EGRESS_PROTOCOLS      https (default) | http | https,http
  AGENT_EGRESS_ALLOW_PRIVATE  on lets it reach private networks (cloud metadata stays refused)
  AGENT_SEARCH                google lets the model search the web (web_search: Google Search via Gemini grounding); off (default)
  AGENT_SEARCH_API_KEY        a Gemini API key (default: AGENT_API_KEY when AGENT_PROVIDER_TYPE=google); never logged
  AGENT_SEARCH_MODEL          the Gemini model that makes the grounding call (default gemini-2.5-flash-lite); spends its tokens
  AGENT_SEARCH_BASE_URL       a gateway in place of the public Gemini endpoint
  AGENT_SEARCH_MAX_RESULTS    results per search (default 5, at most 10)
  AGENT_SEARCH_ALLOW_PRIVATE  on lets that gateway be on a private address
  AGENT_IMAGE_MODEL           an image model id: the model can generate images (generate_image)
  AGENT_SPEECH_MODEL          a speech model id: the model can speak text to a file (generate_speech)
  AGENT_TRANSCRIPTION_MODEL   a transcription model id: /audio <file> attaches audio as text (transcribe_audio)
  AGENT_MEDIA_PROVIDER_TYPE   the provider of those models when not the main one (+ AGENT_MEDIA_API_KEY / _BASE_URL)
  AGENT_MEDIA_DIR             where generated files are kept (default ./agent-media)
  AGENT_MEDIA_MAX_CALLS       media calls one run may make (default 8; 0 = no cap)
  AGENT_SPEECH_VOICE          the default voice of generate_speech (provider-specific id)
  AGENT_SANDBOX               on lets the model run JavaScript it wrote (run_js; needs quickjs-emscripten)
  AGENT_SANDBOX_TIMEOUT_MS    time limit of one run (default 5000, at most 60000)
  AGENT_SANDBOX_MEMORY_MB     heap of one run in MiB (default 32, at most 256)
  AGENT_SUBAGENTS             on lets the model start helper agents itself (spawn_subagent); off (default)
  AGENT_SUBAGENTS_MAX_DEPTH   how deep helpers may nest (default 1: helpers start none; at most 4)
  AGENT_SUBAGENTS_MAX_CHILDREN    helpers one run may start in all (default 8)
  AGENT_SUBAGENTS_MAX_CONCURRENT  helpers of one parent running at once (default 3)
  AGENT_CONTEXT_WINDOW_TOKENS model window (default 128000)
  AGENT_COMPACTION_THRESHOLD  percent of the window at which auto-compaction starts (default 85)
  AGENT_COMPACTION            off disables automatic compaction

Commands inside the REPL:
  /status, /usage, /tools, /history, /reset, /reconnect, /exit (or /quit)
  /compact                    summarise the conversation history now
  /usage                      tokens this session has spent so far, by kind
  /skills, /forget <name>     list skills (the agent's own marked) / delete one the agent learned
  /agents, /stop [n]          while a run goes: list running subagents / stop one (the run goes on);
                              any other text you type then is said to the running agent
  /autopilot                  toggle autopilot (no tool approval prompts)
  /approval <mode>            autopilot | ask-writes | ask-all | read-only

When the approval mode asks, answer y (allow once), n (deny) or a (always
allow this tool for the session). A question nobody answers within 5 minutes
is denied and closed with one line; Ctrl-C closes it with the run.

With AGENT_MCP_ELICITATION, a question from an MCP server is shown as a quotation
("| ..."): answer y to fill in its fields one by one (Enter takes a default or
skips an optional field, /cancel dismisses), n to decline, anything else to
cancel. What you type goes to that server only - not to the model.
`

const FLAG_TO_ENV: Record<string, string> = {
  provider: 'AGENT_PROVIDER_TYPE',
  model: 'AGENT_MODEL',
  'planner-model': 'AGENT_PLANNER_MODEL',
  'synthesizer-model': 'AGENT_SYNTHESIZER_MODEL',
  'base-url': 'AGENT_BASE_URL',
  'log-level': 'AGENT_LOG_LEVEL',
  'max-iterations': 'AGENT_MAX_ITERATIONS',
  'max-steps-per-task': 'AGENT_MAX_STEPS_PER_TASK',
  'tool-strategy': 'AGENT_TOOL_SELECTION_STRATEGY',
}

export const parseCliArgs = (argv: string[]): ICliArgs => {
  const { values } = parseArgs({
    args: argv,
    options: {
      'env-file': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'planner-model': { type: 'string' },
      'synthesizer-model': { type: 'string' },
      'base-url': { type: 'string' },
      'log-level': { type: 'string' },
      'max-iterations': { type: 'string' },
      'max-steps-per-task': { type: 'string' },
      'tool-strategy': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
  const overrides: Record<string, string> = {}
  // values is a heterogeneous record from parseArgs; cast to a string-keyed
  // string|undefined map for the lookup. The schema above only declares
  // string options (besides --help), so this is sound at runtime.
  const lookup = values as Record<string, string | undefined>
  for (const [flag, envVar] of Object.entries(FLAG_TO_ENV)) {
    const v = lookup[flag]
    if (typeof v === 'string' && v.length > 0) {
      overrides[envVar] = v
    }
  }
  return {
    envFile: values['env-file'],
    help: Boolean(values.help),
    overrides,
  }
}
