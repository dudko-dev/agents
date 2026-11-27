import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { McpAppResource } from '@dudko.dev/agent-web'
import type { McpAppHost } from '../hooks/use-mcp-app-host.js'
import { useLabels, type AgentLabelsOverride } from '../labels.js'
import {
  APP_DEFAULT_HEIGHT,
  APP_MAX_HEIGHT,
  buildMcpAppDocument,
  buildMcpAppSandboxShell,
  clampAppHeight,
  MCP_APP_SANDBOX_FRAME_TOKENS,
  MCP_APP_SANDBOX_GRACE_MS,
  MCP_APP_SANDBOX_TIMEOUT_MS,
  McpAppBridge,
  mcpAppHostCapabilities,
  McpAppSandboxLink,
  mcpAppSandboxProxyUrl,
  mcpAppSandboxTarget,
  type McpAppSandboxReason,
} from '../mcp-app.js'
import type { AppView } from '../types.js'
import { errMessage } from '../util.js'
import {
  AlertIcon,
  AppIcon,
  EyeOffIcon,
  LockIcon,
  MoreIcon,
  PanelIcon,
  ReloadIcon,
  SpinnerIcon,
  ToolIcon,
  XIcon,
} from './icons.js'

/** Who the app is told it talks to (`hostInfo` of `ui/initialize`). */
const HOST_INFO = { name: '@dudko.dev/agent-web-react', version: '1' }

/** At most this many of the app's calls are listed under its frame. */
const MAX_LISTED_CALLS = 12

export interface McpAppFrameProps {
  /** The app (an entry of `message.apps`). */
  app: AppView
  /** The host: reads the app, asks the user about its requests (`useMcpAppHost`). */
  host: McpAppHost
  /** `'inline'` under the answer (default), or `'panel'`: it fills the box it is given. */
  variant?: 'inline' | 'panel'
  /** The colour scheme the app is told (`hostContext.theme`). */
  theme?: 'light' | 'dark'
  /** Start folded to one line (default false). */
  defaultCollapsed?: boolean
  /** Adds "Open in panel" (a header button and a menu item). */
  onOpenPanel?: () => void
  /** In the panel: the close button (the app goes back into the chat). */
  onClosePanel?: () => void
  /** The tools the app ran, listed under the frame (default true). */
  showCalls?: boolean
  labels?: AgentLabelsOverride
  className?: string
}

type Loaded = { resource: McpAppResource } | { error: string } | { unavailable: true }

/** Where an app runs: an opaque frame of ours, or the sandbox page on its own origin. */
type Placement =
  { mode: 'opaque'; reason?: McpAppSandboxReason } | { mode: 'origin'; origin: string; url: string }

// Sandbox origins whose page did not answer, for the life of this page: the next frame does not
// wait for them again (its Reload tries again).
const silentSandboxes = new Set<string>()
const warned = new Set<string>()
const warnOnce = (key: string, text: string) => {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[@dudko.dev/agent-web-react] ${text}`)
}
const SANDBOX_WARNINGS: Record<McpAppSandboxReason, string> = {
  invalid: 'is not a URL a sandbox can be served at (no credentials, query or fragment)',
  insecure: 'is not https:// (http:// only on localhost / 127.0.0.1)',
  'same-origin':
    "is on this page's own origin - an app there would have your storage and the key vault",
  'no-page-origin': 'cannot be checked: this page has no origin of its own',
  'server-name': 'has {server}, and this server name is not a lowercase DNS label',
  'too-many-origins': 'cannot carry this app: it declares too many origins',
  'no-answer': 'did not answer the handshake in time',
}

const pageOrigin = (): string | undefined =>
  typeof location === 'undefined' ? undefined : location.origin

/**
 * An MCP App inside chrome the host draws: "App from server “travel” · sandboxed", the host's
 * controls (panel, menu: reload / open in panel / hide) and the list of what the app ran - all
 * OUTSIDE the frame, where the app cannot paint over them. The app runs in the boundary
 * `mcp-app.ts` builds: an opaque origin - or, with `host.sandbox`, an origin of its own behind the
 * sandbox page (falling back to the opaque frame when that page does not answer) - network only
 * where its resource declared it, no navigation, and every request that does something (a tool
 * call, a link, a message) put to the user through the host. Its height is its wish, clamped to
 * 120 - 800 px.
 */
export const McpAppFrame = ({
  app,
  host,
  variant = 'inline',
  theme,
  defaultCollapsed = false,
  onOpenPanel,
  onClosePanel,
  showCalls = true,
  labels,
  className,
}: McpAppFrameProps) => {
  const L = useLabels(labels)
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const [menu, setMenu] = useState(false)
  const [reload, setReload] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | undefined>()
  const [height, setHeight] = useState(APP_DEFAULT_HEIGHT)
  const [calls, setCalls] = useState<{ name: string; ok: boolean }[]>([])
  // The sandbox origin: gave up on it (`fallback`), the app reloaded its proxy (`broken`), the
  // handshake is done (`onOrigin`).
  const [fallback, setFallback] = useState<McpAppSandboxReason | undefined>()
  const [broken, setBroken] = useState(false)
  const [onOrigin, setOnOrigin] = useState(false)
  const shellLoaded = useRef<(() => void) | undefined>(undefined)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const bridgeRef = useRef<McpAppBridge | undefined>(undefined)
  const menuRef = useRef<HTMLDivElement>(null)
  const themeRef = useRef(theme)
  themeRef.current = theme
  const hostRef = useRef(host)
  hostRef.current = host
  // The app is known by its id: a host that hands a new object each render does not reload it.
  const appRef = useRef(app)
  appRef.current = app
  const live = !collapsed

  // Read the app from the server that declared it (cached by the connection).
  useEffect(() => {
    if (!live) return
    if (!hostRef.current.connected) {
      setLoaded({ unavailable: true })
      return
    }
    let gone = false
    setLoaded(undefined)
    hostRef.current.read(appRef.current).then(
      (resource) => {
        if (!gone) setLoaded({ resource })
      },
      (err) => {
        if (!gone) setLoaded({ error: errMessage(err) })
      },
    )
    return () => {
      gone = true
    }
  }, [live, host.connected, app.id, reload])

  const resource = loaded && 'resource' in loaded ? loaded.resource : undefined
  const sandboxUrl = host.sandbox?.url
  const timeoutMs = host.sandbox?.timeoutMs ?? MCP_APP_SANDBOX_TIMEOUT_MS
  const placement = useMemo<Placement | undefined>(() => {
    if (!resource) return undefined
    if (sandboxUrl === undefined) return { mode: 'opaque' }
    if (fallback) return { mode: 'opaque', reason: fallback }
    const target = mcpAppSandboxTarget({ url: sandboxUrl }, app.server, pageOrigin())
    if (!target.ok) return { mode: 'opaque', reason: target.reason }
    if (silentSandboxes.has(target.origin)) return { mode: 'opaque', reason: 'no-answer' }
    const url = mcpAppSandboxProxyUrl(target.base, resource.csp)
    if (!url) return { mode: 'opaque', reason: 'too-many-origins' }
    return { mode: 'origin', origin: target.origin, url }
    // `reload`: a reload asks again (an origin given up on may answer now).
  }, [resource, sandboxUrl, fallback, app.server, reload])
  const doc = useMemo(
    () =>
      !resource || !placement
        ? undefined
        : placement.mode === 'origin'
          ? buildMcpAppSandboxShell(placement.url)
          : buildMcpAppDocument(resource.html, resource.csp),
    [resource, placement],
  )

  // A sandbox URL this frame cannot use is said once, in the console, and the app runs opaque.
  useEffect(() => {
    const reason = placement?.mode === 'opaque' ? placement.reason : undefined
    if (reason && reason !== 'no-answer' && sandboxUrl !== undefined) {
      warnOnce(
        `${sandboxUrl}\u0000${reason}`,
        `MCP Apps: the sandbox URL ${sandboxUrl} ${SANDBOX_WARNINGS[reason]}; apps run in the opaque sandbox.`,
      )
    }
  }, [placement, sandboxUrl])

  // The bridge: one per drawn frame, answering only that frame's window.
  useEffect(() => {
    const frame = iframeRef.current
    if (!live || !resource || !frame || !placement || broken) return
    const abort = new AbortController()
    const app = appRef.current
    const record = (name: string, ok: boolean) =>
      setCalls((list) => [...list, { name, ok }].slice(-MAX_LISTED_CALLS))
    const tool = hostRef.current.tool(app)
    // On its own origin: the proxy's window is the one frame in the shell (same origin as this
    // page), and every message to it goes to the sandbox origin.
    const proxyOf = (): Window | undefined => frame.contentWindow?.frames[0] ?? undefined
    const link =
      placement.mode === 'origin'
        ? new McpAppSandboxLink({
            origin: placement.origin,
            html: resource.html,
            csp: resource.csp,
            post: (message, targetOrigin) => proxyOf()?.postMessage(message, targetOrigin),
          })
        : undefined
    const bridge = new McpAppBridge({
      post: link
        ? (message) => link.post(message)
        : (message) => frame.contentWindow?.postMessage(message, '*'),
      handlers: {
        callTool: async (name, args) => {
          try {
            const result = await hostRef.current.callTool(app, name, args, abort.signal)
            record(name, true)
            return result
          } catch (err) {
            record(name, false)
            throw err
          }
        },
        openLink: (link) => hostRef.current.openLink(app, link, abort.signal),
        message: (text) => hostRef.current.message(app, text, abort.signal),
        resize: (wish) => {
          if (variant === 'inline') setHeight(clampAppHeight(wish))
        },
      },
      hostInfo: HOST_INFO,
      hostCapabilities: mcpAppHostCapabilities(resource.csp),
      hostContext: {
        toolInfo: {
          tool: {
            name: app.toolName,
            ...(tool?.description ? { description: tool.description } : {}),
            inputSchema: tool?.inputSchema ?? { type: 'object' },
          },
        },
        ...(themeRef.current ? { theme: themeRef.current } : {}),
        displayMode: 'inline',
        availableDisplayModes: ['inline'],
        containerDimensions: { maxHeight: APP_MAX_HEIGHT },
        platform: 'web',
        ...(typeof navigator !== 'undefined' && navigator.language
          ? { locale: navigator.language }
          : {}),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      toolInput: app.input,
      ...(app.result
        ? { toolResult: app.result }
        : { cancelledReason: 'the result was too large to hand to the app' }),
    })
    bridgeRef.current = bridge
    // The sandbox page did not answer: the app runs in the opaque frame instead (stricter), and
    // the next frame does not wait for that origin again.
    const timers: ReturnType<typeof setTimeout>[] = []
    const giveUp = () => {
      if (!link || link.ready || link.broken || placement.mode !== 'origin') return
      silentSandboxes.add(placement.origin)
      warnOnce(
        `${placement.origin}\u0000no-answer`,
        `MCP Apps: the sandbox page at ${placement.origin} ${SANDBOX_WARNINGS['no-answer']}; apps run in the opaque sandbox.`,
      )
      setFallback('no-answer')
    }
    if (link) {
      timers.push(setTimeout(giveUp, timeoutMs))
      // The shell's load waits for the proxy's: loaded (or failed) and still silent, it is not
      // coming.
      shellLoaded.current = () => timers.push(setTimeout(giveUp, MCP_APP_SANDBOX_GRACE_MS))
    }
    const onMessage = (event: MessageEvent) => {
      if (link) {
        // The proxy's window AND the sandbox origin, or nothing (`McpAppSandboxLink`).
        const input = link.receive(event, proxyOf())
        if (input === 'ready') setOnOrigin(true)
        else if (input === 'app') bridge.receive(event.data)
        else if (input === 'broken') {
          // The proxy page was loaded again (the app navigated it): stop the app.
          bridge.close()
          abort.abort()
          setBroken(true)
        }
        return
      }
      // Only the frame drawn here. The app's own window writing to the top directly, another
      // frame, or the page itself: none of them is this app.
      if (event.source !== frame.contentWindow) return
      bridge.receive(event.data)
    }
    window.addEventListener('message', onMessage)
    return () => {
      for (const t of timers) clearTimeout(t)
      shellLoaded.current = undefined
      window.removeEventListener('message', onMessage)
      bridge.teardown('the app was closed')
      bridge.close()
      link?.close()
      // Whatever the app still waits for (a prompt, a consent) is given up.
      abort.abort()
      bridgeRef.current = undefined
    }
  }, [live, resource, reload, variant, app.id, placement, broken, timeoutMs])

  // A theme switch reaches an app that is running.
  useEffect(() => {
    if (theme) bridgeRef.current?.updateContext({ theme })
  }, [theme])

  // The menu closes on a click elsewhere, and on Escape.
  useEffect(() => {
    if (!menu) return
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === 'Escape'
          : !menuRef.current?.contains(e.target as Node)
      ) {
        setMenu(false)
      }
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [menu])

  const doReload = () => {
    setMenu(false)
    setHeight(APP_DEFAULT_HEIGHT)
    if (sandboxUrl !== undefined) {
      const target = mcpAppSandboxTarget({ url: sandboxUrl }, app.server, pageOrigin())
      if (target.ok) silentSandboxes.delete(target.origin)
    }
    setFallback(undefined)
    setBroken(false)
    setOnOrigin(false)
    setReload((n) => n + 1)
  }

  if (collapsed) {
    return (
      <McpAppLine
        app={app}
        note={L.appHidden}
        action={L.appShow}
        onAction={() => setCollapsed(false)}
        labels={labels}
        className={className}
      />
    )
  }

  const waiting = host.isWaiting(app)
  const panel = variant === 'panel'
  const sandboxed = placement?.mode === 'origin' && onOrigin
  const sandboxNote =
    placement?.mode === 'origin'
      ? onOrigin
        ? L.appSandboxOrigin(placement.origin)
        : undefined
      : placement?.reason
        ? L.appSandboxFallback(L.appSandboxReasons[placement.reason])
        : undefined
  const badge = (
    <span title={sandboxNote}>
      <LockIcon size={11} /> {sandboxed ? L.appSandboxedOrigin : L.appSandboxed}
    </span>
  )
  const body = !loaded ? (
    <div className="awr-frame__status">
      <SpinnerIcon size={13} /> {L.appLoading}
    </div>
  ) : 'unavailable' in loaded ? (
    <div className="awr-frame__status awr-frame__status--error" role="alert">
      <AlertIcon size={13} /> {L.appUnavailable(app.server)}
    </div>
  ) : 'error' in loaded ? (
    <div className="awr-frame__status awr-frame__status--error" role="alert">
      <AlertIcon size={13} /> {L.appFailed(loaded.error)}
    </div>
  ) : broken ? (
    <div className="awr-frame__status awr-frame__status--error" role="alert">
      <AlertIcon size={13} /> {L.appSandboxBroken}
    </div>
  ) : (
    <div className="awr-frame__well">
      {placement?.mode === 'origin' ? (
        <iframe
          // The shell (ours, this page's origin, no script) around the sandbox page.
          key={`${reload}:origin`}
          ref={iframeRef}
          className="awr-frame__iframe"
          title={L.appFrameName(app.server)}
          sandbox={MCP_APP_SANDBOX_FRAME_TOKENS}
          referrerPolicy="no-referrer"
          srcDoc={doc}
          onLoad={() => shellLoaded.current?.()}
          style={panel ? undefined : { height }}
        />
      ) : (
        <iframe
          // A reload is a new frame: a new window, a new bridge, the app from the start.
          key={`${reload}:opaque`}
          ref={iframeRef}
          className="awr-frame__iframe"
          title={L.appFrameName(app.server)}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={doc}
          style={panel ? undefined : { height }}
        />
      )}
    </div>
  )

  return (
    <div
      className={[
        'awr-frame awr-frame--app',
        panel && 'awr-frame--panel',
        waiting && 'is-waiting',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-app={app.id}
      data-sandbox={
        placement?.mode === 'origin' ? (onOrigin ? 'origin' : 'connecting') : placement?.mode
      }
    >
      <div className="awr-frame__head">
        <AppIcon size={14} className="awr-frame__icon" />
        {panel ? (
          <div className="awr-frame__label">
            <span className="awr-frame__titles">
              <span className="awr-frame__title">{L.appFrom(app.server)}</span>
              <span className="awr-frame__badges">
                {badge} · {app.resourceUri}
              </span>
            </span>
            {waiting && <span className="awr-frame__state">{L.appWaiting}</span>}
          </div>
        ) : (
          <div className="awr-frame__label">
            <span className="awr-frame__title">{L.appFrom(app.server)}</span>
            <span className="awr-frame__badges">{badge}</span>
            {waiting && <span className="awr-frame__state">{L.appWaiting}</span>}
          </div>
        )}
        {panel ? (
          <>
            <button
              type="button"
              className="awr-frame__btn"
              aria-label={L.appReload}
              title={L.appReload}
              onClick={doReload}
            >
              <ReloadIcon size={15} />
            </button>
            {onClosePanel && (
              <button
                type="button"
                className="awr-frame__btn"
                aria-label={L.appClosePanel}
                title={L.appClosePanel}
                onClick={onClosePanel}
              >
                <XIcon size={15} />
              </button>
            )}
          </>
        ) : (
          <>
            {onOpenPanel && (
              <button
                type="button"
                className="awr-frame__btn"
                aria-label={L.appOpenPanel}
                title={L.appOpenPanel}
                onClick={onOpenPanel}
              >
                <PanelIcon size={15} />
              </button>
            )}
            <button
              type="button"
              className={`awr-frame__btn${menu ? ' is-on' : ''}`}
              aria-label={L.appMenu}
              title={L.appMenu}
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu((m) => !m)}
            >
              <MoreIcon size={15} />
            </button>
          </>
        )}
      </div>
      {menu && !panel && (
        <div className="awr-frame__menu" role="menu" ref={menuRef}>
          <button type="button" role="menuitem" className="awr-frame__menuitem" onClick={doReload}>
            <ReloadIcon size={14} /> {L.appReload}
          </button>
          {onOpenPanel && (
            <button
              type="button"
              role="menuitem"
              className="awr-frame__menuitem"
              onClick={() => {
                setMenu(false)
                onOpenPanel()
              }}
            >
              <PanelIcon size={14} /> {L.appOpenPanel}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="awr-frame__menuitem"
            onClick={() => {
              setMenu(false)
              setCollapsed(true)
            }}
          >
            <EyeOffIcon size={14} /> {L.appHide}
          </button>
          <div className="awr-frame__menusep" />
          <p className="awr-frame__menunote">{L.appServedBy(app.server, app.resourceUri)}</p>
          {sandboxNote && <p className="awr-frame__menunote">{sandboxNote}</p>}
        </div>
      )}
      {body}
      {panel ? (
        <div className="awr-frame__foot">
          <LockIcon size={11} />{' '}
          <span className="awr-frame__footmeta">{L.appPanelNote(app.server)}</span>
        </div>
      ) : showCalls && calls.length > 0 ? (
        <div className="awr-frame__foot">
          <ToolIcon size={11} />
          <span className="awr-frame__footmeta">
            {L.appRan(
              calls.map((c) => (c.ok ? c.name : `${c.name} (${L.appRefused})`)).join(' · '),
            )}
          </span>
        </div>
      ) : null}
    </div>
  )
}

export interface McpAppLineProps {
  app: AppView
  /** What the line says after the title ("hidden", "open in the panel"). */
  note: ReactNode
  /** The button ("Show", "Bring back"). */
  action: ReactNode
  onAction: () => void
  labels?: AgentLabelsOverride
  className?: string
}

/** An app folded to one line: where it was, and the button that brings it back. */
export const McpAppLine = ({ app, note, action, onAction, labels, className }: McpAppLineProps) => {
  const L = useLabels(labels)
  return (
    <div
      className={['awr-frame awr-frame--app awr-frame--line', className].filter(Boolean).join(' ')}
      data-app={app.id}
    >
      <div className="awr-frame__head">
        <AppIcon size={14} className="awr-frame__icon" />
        <div className="awr-frame__label">
          <span className="awr-frame__title">{L.appFrom(app.server)}</span>
          <span className="awr-frame__badges">{note}</span>
        </div>
        <button type="button" className="awr-btn awr-frame__show" onClick={onAction}>
          {action}
        </button>
      </div>
    </div>
  )
}
