import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { McpAppResource } from '@dudko.dev/agent-web'
import type { McpAppHost } from '../hooks/use-mcp-app-host.js'
import { useLabels, type AgentLabelsOverride } from '../labels.js'
import {
  APP_DEFAULT_HEIGHT,
  APP_MAX_HEIGHT,
  buildMcpAppDocument,
  clampAppHeight,
  McpAppBridge,
  mcpAppHostCapabilities,
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

/**
 * An MCP App inside chrome the host draws: "App from server “travel” · sandboxed", the host's
 * controls (panel, menu: reload / open in panel / hide) and the list of what the app ran - all
 * OUTSIDE the frame, where the app cannot paint over them. The app runs in the boundary
 * `mcp-app.ts` builds: an opaque origin, network only where its resource declared it, no
 * navigation, and every request that does something (a tool call, a link, a message) put to the
 * user through the host. Its height is its wish, clamped to 120 - 800 px.
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
  const doc = useMemo(
    () => (resource ? buildMcpAppDocument(resource.html, resource.csp) : undefined),
    [resource],
  )

  // The bridge: one per drawn frame, answering only that frame's window.
  useEffect(() => {
    const frame = iframeRef.current
    if (!live || !resource || !frame) return
    const abort = new AbortController()
    const app = appRef.current
    const record = (name: string, ok: boolean) =>
      setCalls((list) => [...list, { name, ok }].slice(-MAX_LISTED_CALLS))
    const tool = hostRef.current.tool(app)
    const bridge = new McpAppBridge({
      post: (message) => frame.contentWindow?.postMessage(message, '*'),
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
    const onMessage = (event: MessageEvent) => {
      // Only the frame drawn here. The app's own window writing to the top directly, another
      // frame, or the page itself: none of them is this app.
      if (event.source !== frame.contentWindow) return
      bridge.receive(event.data)
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      bridge.teardown('the app was closed')
      bridge.close()
      // Whatever the app still waits for (a prompt, a consent) is given up.
      abort.abort()
      bridgeRef.current = undefined
    }
  }, [live, resource, reload, variant, app.id])

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
  ) : (
    <div className="awr-frame__well">
      <iframe
        // A reload is a new frame: a new window, a new bridge, the app from the start.
        key={reload}
        ref={iframeRef}
        className="awr-frame__iframe"
        title={L.appFrameName(app.server)}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={doc}
        style={panel ? undefined : { height }}
      />
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
    >
      <div className="awr-frame__head">
        <AppIcon size={14} className="awr-frame__icon" />
        {panel ? (
          <div className="awr-frame__label">
            <span className="awr-frame__titles">
              <span className="awr-frame__title">{L.appFrom(app.server)}</span>
              <span className="awr-frame__badges">
                <LockIcon size={11} /> {L.appSandboxed} · {app.resourceUri}
              </span>
            </span>
            {waiting && <span className="awr-frame__state">{L.appWaiting}</span>}
          </div>
        ) : (
          <div className="awr-frame__label">
            <span className="awr-frame__title">{L.appFrom(app.server)}</span>
            <span className="awr-frame__badges">
              <LockIcon size={11} /> {L.appSandboxed}
            </span>
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
