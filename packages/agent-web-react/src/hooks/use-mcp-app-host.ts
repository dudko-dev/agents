import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppToolCallRequest, McpAppResource, McpAppToolResult } from '@dudko.dev/agent-web'
import {
  MCP_APP_REFUSED,
  McpAppRpcError,
  type AppLink,
  type McpAppSandboxOptions,
} from '../mcp-app.js'
import type { AppView, ApprovalView } from '../types.js'

/**
 * The connection's side of MCP Apps, structurally: the core's `ConnectedMcp.apps` (`./mcp`,
 * `apps: true`), or the one `useMcp` / `useMcpServers` return. Every method names the server,
 * and the host always passes the app's OWN server: an app reads and calls only what its server
 * declared.
 */
export interface McpAppsConnectionLike {
  readUiResource: (
    server: string,
    uri: string,
    options?: { signal?: AbortSignal },
  ) => Promise<McpAppResource>
  appTool: (
    server: string,
    name: string,
  ) => { key: string; readOnly: boolean; description?: string; inputSchema?: unknown } | undefined
  callAppTool: (
    server: string,
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) => Promise<McpAppToolResult>
}

/** A link or a message an app asks for, waiting for the user (`<AppRequestPrompt>`). */
export interface AppRequestView {
  id: string
  /** The app (`AppView.id`) that asks. */
  appId: string
  server: string
  kind: 'link' | 'message'
  /** `kind: 'link'`: the link, taken apart (the host is what the user checks). */
  link?: AppLink
  /** `kind: 'message'`: the app's text, cleaned. */
  text?: string
}

/** What `<McpAppFrame>` asks of the host, and what the host shows the user. */
export interface McpAppHost {
  /** No connection (apps are off, or the server is gone): frames say so. */
  connected: boolean
  read: (app: AppView, signal?: AbortSignal) => Promise<McpAppResource>
  /** The tool an app's tool-info names (for its host context); undefined when unknown. */
  tool: (app: AppView) => { description?: string; inputSchema?: unknown } | undefined
  /** An app's `tools/call`: the agent's consent gate first, then the call. Throws when refused. */
  callTool: (
    app: AppView,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<McpAppToolResult>
  /** An app's `ui/open-link`: true once the user opened it, false when they did not. */
  openLink: (app: AppView, link: AppLink, signal?: AbortSignal) => Promise<boolean>
  /** An app's `ui/message`: true once the user put it in the message box. */
  message: (app: AppView, text: string, signal?: AbortSignal) => Promise<boolean>
  /** Links and messages waiting for the user. */
  requests: AppRequestView[]
  /**
   * The user's answer to a request. Call it from the click: an accepted link is opened right
   * there (`window.open`, `noopener,noreferrer`) and nowhere else.
   */
  answer: (id: string, accept: boolean) => void
  /** The last message the user accepted: the composer appends it as a draft (never sends it). */
  draft?: { id: string; text: string }
  /** Whether the app has something waiting for the user (a link, a message, a tool call). */
  isWaiting: (app: AppView) => boolean
  /**
   * Where apps run: on an origin of their own, through the sandbox page at this URL - or, when
   * absent (the default), in an opaque frame. See `McpAppSandboxOptions`.
   */
  sandbox?: McpAppSandboxOptions
}

export interface UseMcpAppHostOptions {
  /** The connection(s) the apps came from; without one, frames say their server is not connected. */
  connection?: McpAppsConnectionLike
  /** The agent's consent gate for an app's calls: `useAgent().approveAppToolCall`. */
  approve?: (call: AppToolCallRequest, signal?: AbortSignal) => Promise<void>
  /** The pending consent requests (`useAgent().pendingApprovals`): an app's are its "waiting". */
  approvals?: ApprovalView[]
  /**
   * Run apps on an origin of their own: the URL of a sandbox page you serve on ANOTHER origin
   * (`./mcp-app-sandbox`). Without it, apps run in an opaque frame (no storage of their own).
   */
  sandbox?: McpAppSandboxOptions
}

let seq = 0

const refused = (message: string): McpAppRpcError => new McpAppRpcError(MCP_APP_REFUSED, message)

/**
 * The host's side of MCP Apps for a chat: reads an app from its own server, puts each tool call
 * an app asks for through the agent's consent gate, and holds the link and message requests until
 * the user answers. `<AgentChat mcpApps={…}>` uses it; use it yourself with `<McpAppFrame>` and
 * `<AppRequestPrompt>` in your own UI.
 */
export const useMcpAppHost = ({
  connection,
  approve,
  approvals = [],
  sandbox,
}: UseMcpAppHostOptions): McpAppHost => {
  const [requests, setRequests] = useState<AppRequestView[]>([])
  const [draft, setDraft] = useState<{ id: string; text: string } | undefined>()
  const waiting = useRef(
    new Map<string, { request: AppRequestView; resolve: (ok: boolean) => void }>(),
  )
  // Calls of an app that wait in the agent's gate, by app id (for "waiting for you").
  const [gated, setGated] = useState<Record<string, number>>({})
  const connectionRef = useRef(connection)
  connectionRef.current = connection
  const approveRef = useRef(approve)
  approveRef.current = approve

  // Nothing is left waiting behind an unmounted chat.
  useEffect(
    () => () => {
      for (const { resolve } of waiting.current.values()) resolve(false)
      waiting.current.clear()
    },
    [],
  )

  const ask = useCallback(
    (request: Omit<AppRequestView, 'id'>, signal?: AbortSignal): Promise<boolean> => {
      // One question per app at a time: an app cannot pile up prompts.
      for (const w of waiting.current.values()) {
        if (w.request.appId === request.appId) {
          return Promise.reject(refused('Another request of this app is waiting for the user'))
        }
      }
      if (signal?.aborted) return Promise.resolve(false)
      seq += 1
      const full: AppRequestView = { ...request, id: `app-request-${seq}` }
      return new Promise<boolean>((resolve) => {
        const done = (ok: boolean) => {
          if (!waiting.current.delete(full.id)) return
          signal?.removeEventListener('abort', onAbort)
          setRequests((list) => list.filter((r) => r.id !== full.id))
          resolve(ok)
        }
        const onAbort = () => done(false)
        signal?.addEventListener('abort', onAbort, { once: true })
        waiting.current.set(full.id, { request: full, resolve: done })
        setRequests((list) => [...list, full])
      })
    },
    [],
  )

  const answer = useCallback((id: string, accept: boolean) => {
    const w = waiting.current.get(id)
    if (!w) return
    if (accept && w.request.kind === 'link' && w.request.link) {
      // Only here, on the user's click, and without an opener or a referrer.
      globalThis.open?.(w.request.link.href, '_blank', 'noopener,noreferrer')
    }
    if (accept && w.request.kind === 'message' && w.request.text) {
      setDraft({ id, text: w.request.text })
    }
    w.resolve(accept)
  }, [])

  const read = useCallback((app: AppView, signal?: AbortSignal) => {
    const c = connectionRef.current
    if (!c) return Promise.reject(new Error(`no connection to the server “${app.server}”`))
    return c.readUiResource(app.server, app.resourceUri, signal ? { signal } : undefined)
  }, [])

  const tool = useCallback(
    (app: AppView) => connectionRef.current?.appTool(app.server, app.toolName),
    [],
  )

  const callTool = useCallback(
    async (
      app: AppView,
      name: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<McpAppToolResult> => {
      const c = connectionRef.current
      if (!c) throw refused(`The server “${app.server}” is not connected`)
      // Only a tool of the app's OWN server that lets apps call it (visibility 'app').
      const t = c.appTool(app.server, name)
      if (!t) throw new McpAppRpcError(-32602, `This app may not call “${name.slice(0, 80)}”`)
      const gate = approveRef.current
      if (!gate) throw refused('This host cannot ask the user about an app’s tool calls')
      setGated((g) => ({ ...g, [app.id]: (g[app.id] ?? 0) + 1 }))
      try {
        await gate(
          {
            tool: t.key,
            toolName: name,
            server: app.server,
            resourceUri: app.resourceUri,
            input: args,
            readOnly: t.readOnly,
          },
          signal,
        )
      } catch (err) {
        const denied = err instanceof Error && err.name === 'ToolDeniedError'
        throw refused(
          denied
            ? 'Tool call denied by the user'
            : err instanceof Error
              ? err.message
              : String(err),
        )
      } finally {
        setGated((g) => {
          const next = { ...g, [app.id]: (g[app.id] ?? 1) - 1 }
          if (next[app.id] <= 0) delete next[app.id]
          return next
        })
      }
      return c.callAppTool(app.server, name, args, signal ? { signal } : undefined)
    },
    [],
  )

  const openLink = useCallback(
    (app: AppView, link: AppLink, signal?: AbortSignal) =>
      ask({ appId: app.id, server: app.server, kind: 'link', link }, signal),
    [ask],
  )
  const message = useCallback(
    (app: AppView, text: string, signal?: AbortSignal) =>
      ask({ appId: app.id, server: app.server, kind: 'message', text }, signal),
    [ask],
  )

  const pendingAppServers = useMemo(
    () =>
      new Set(
        approvals
          .filter((a) => a.app && a.status === 'pending')
          .map((a) => `${a.app!.server}\u0000${a.app!.resourceUri}`),
      ),
    [approvals],
  )

  const isWaiting = useCallback(
    (app: AppView) =>
      requests.some((r) => r.appId === app.id) ||
      (Boolean(gated[app.id]) && pendingAppServers.has(`${app.server}\u0000${app.resourceUri}`)),
    [requests, gated, pendingAppServers],
  )

  // A new object each render (an inline prop) is the same setting.
  const sandboxUrl = sandbox?.url
  const sandboxTimeout = sandbox?.timeoutMs
  const sandboxSetting = useMemo<McpAppSandboxOptions | undefined>(
    () =>
      sandboxUrl === undefined
        ? undefined
        : {
            url: sandboxUrl,
            ...(sandboxTimeout !== undefined ? { timeoutMs: sandboxTimeout } : {}),
          },
    [sandboxUrl, sandboxTimeout],
  )

  return useMemo(
    () => ({
      connected: Boolean(connection),
      read,
      tool,
      callTool,
      openLink,
      message,
      requests,
      answer,
      draft,
      isWaiting,
      ...(sandboxSetting ? { sandbox: sandboxSetting } : {}),
    }),
    [
      connection,
      read,
      tool,
      callTool,
      openLink,
      message,
      requests,
      answer,
      draft,
      isWaiting,
      sandboxSetting,
    ],
  )
}
