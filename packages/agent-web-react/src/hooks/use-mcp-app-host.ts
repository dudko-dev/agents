import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppSamplingRequest,
  AppSamplingResult,
  AppSamplingView,
  AppToolCallRequest,
  McpAppResource,
  McpAppToolResult,
} from '@dudko.dev/agent-web'
import {
  appSamplingErrorOf,
  MCP_APP_REFUSED,
  McpAppRpcError,
  resolveAppDownload,
  saveAppFile,
  type AppDownload,
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
  /**
   * A resource of that server for a file its app asks to save (a `resource_link`): the core's
   * `ConnectedMcp.apps.readResource` - `resources/read` on that server, never a fetch. Older
   * cores have none: a linked file is then refused.
   */
  readResource?: (
    server: string,
    uri: string,
    options?: { signal?: AbortSignal; maxBytes?: number },
  ) => Promise<{ uri: string; mimeType?: string; bytes: Uint8Array }>
}

/** A file an app asks to save, as the prompt shows it (the bytes stay with the host). */
export interface AppDownloadView {
  /** What it will be saved as (sanitized). */
  name: string
  /** The declared type, if any (the server's, for a linked file). */
  mimeType?: string
  /** Bytes. */
  size: number
  /** In the request (`embedded`), or read from the app's server (`link`). */
  source: 'embedded' | 'link'
}

/** What an app asks for besides a tool call, waiting for the user (`<AppRequestPrompt>`). */
export interface AppRequestView {
  id: string
  /** The app (`AppView.id`) that asks. */
  appId: string
  server: string
  kind: 'link' | 'message' | 'download' | 'sampling'
  /** `kind: 'link'`: the link, taken apart (the host is what the user checks). */
  link?: AppLink
  /** `kind: 'message'`: the app's text, cleaned. */
  text?: string
  /** `kind: 'download'`: the file. */
  download?: AppDownloadView
  /** `kind: 'sampling'`: exactly what the model would get (the core checked and cleaned it). */
  sampling?: AppSamplingView
}

/** How the user answered (`answer(id, accept, options)`). */
export interface AppRequestAnswerOptions {
  /** A sampling request: allow this app's requests until the page is reloaded. */
  always?: boolean
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
  /**
   * An app's `ui/download-file` (checked by the bridge): true once the user saved it, false when
   * they did not. Present only with `downloads` on: absent, the method is not offered.
   */
  downloadFile?: (app: AppView, file: AppDownload, signal?: AbortSignal) => Promise<boolean>
  /**
   * An app's `sampling/createMessage`: the agent's model answers it (the core's
   * `Agent.sampleForApp`), after the user said yes. Present only with `sampling` on and a
   * `sample` given: absent, the method is not offered.
   */
  sample?: (app: AppView, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
  /** Links, messages, files and sampling requests waiting for the user. */
  requests: AppRequestView[]
  /**
   * The user's answer to a request. Call it from the click: an accepted link is opened right
   * there (`window.open`, `noopener,noreferrer`) and an accepted file saved right there
   * (`saveAppFile`), nowhere else. `always` (a sampling request): this app's next requests are
   * not asked about until the page is reloaded.
   */
  answer: (id: string, accept: boolean, options?: AppRequestAnswerOptions) => void
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
  /**
   * Let apps hand the user a file to save (`ui/download-file`, `hostCapabilities.downloadFile`).
   * Each file is put to the user (name, type, size) and saved only on their click. Default false.
   */
  downloads?: boolean
  /**
   * Let apps ask the agent's model for a completion (`sampling/createMessage`,
   * `hostCapabilities.sampling` - never `sampling.tools`). Needs `sample`. Default false.
   */
  sampling?: boolean
  /** The agent's seam for it: `useAgent().sampleForApp`. */
  sample?: (
    request: AppSamplingRequest,
    approve: (view: AppSamplingView) => Promise<boolean>,
    signal?: AbortSignal,
  ) => Promise<AppSamplingResult>
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
  downloads = false,
  sampling = false,
  sample: sampleFn,
}: UseMcpAppHostOptions): McpAppHost => {
  const [requests, setRequests] = useState<AppRequestView[]>([])
  const [draft, setDraft] = useState<{ id: string; text: string } | undefined>()
  const waiting = useRef(
    new Map<
      string,
      {
        request: AppRequestView
        resolve: (ok: boolean) => void
        /** A file to save on the user's Allow (never in state). */
        file?: { name: string; bytes: Uint8Array }
        /** A sampling request: the app's key, for "always for this app". */
        app?: string
      }
    >(),
  )
  // Apps whose sampling the user allowed until the page is reloaded (server + resource).
  const samplingAllowed = useRef(new Set<string>())
  const sampleRef = useRef(sampleFn)
  sampleRef.current = sampleFn
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
    (
      request: Omit<AppRequestView, 'id'>,
      signal?: AbortSignal,
      extra: { file?: { name: string; bytes: Uint8Array }; app?: string } = {},
    ): Promise<boolean> => {
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
        waiting.current.set(full.id, { request: full, resolve: done, ...extra })
        setRequests((list) => [...list, full])
      })
    },
    [],
  )

  const answer = useCallback((id: string, accept: boolean, options?: AppRequestAnswerOptions) => {
    const w = waiting.current.get(id)
    if (!w) return
    if (accept && w.request.kind === 'link' && w.request.link) {
      // Only here, on the user's click, and without an opener or a referrer.
      globalThis.open?.(w.request.link.href, '_blank', 'noopener,noreferrer')
    }
    if (accept && w.request.kind === 'message' && w.request.text) {
      setDraft({ id, text: w.request.text })
    }
    if (accept && w.request.kind === 'download' && w.file) {
      // Only here, on the user's click: a blob of this page, an <a download> of ours.
      try {
        saveAppFile(w.file, {
          document,
          URL,
          setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
        })
      } catch {
        w.resolve(false)
        return
      }
    }
    if (accept && options?.always && w.request.kind === 'sampling' && w.app) {
      samplingAllowed.current.add(w.app)
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

  const downloadFile = useCallback(
    async (app: AppView, file: AppDownload, signal?: AbortSignal): Promise<boolean> => {
      const c = connectionRef.current
      if (file.kind === 'link' && !c) throw refused(`The server “${app.server}” is not connected`)
      // A linked file is read from the app's OWN server through the connection - never fetched.
      const ready = await resolveAppDownload(file, app.server, c?.readResource, signal)
      return ask(
        {
          appId: app.id,
          server: app.server,
          kind: 'download',
          download: {
            name: ready.name,
            ...(ready.mimeType ? { mimeType: ready.mimeType } : {}),
            size: ready.bytes.length,
            source: ready.source,
          },
        },
        signal,
        { file: { name: ready.name, bytes: ready.bytes } },
      )
    },
    [ask],
  )

  const sample = useCallback(
    async (app: AppView, params: Record<string, unknown>, signal?: AbortSignal) => {
      const fn = sampleRef.current
      if (!fn) throw refused('This host cannot answer sampling requests')
      const key = `${app.server}\u0000${app.resourceUri}`
      try {
        return await fn(
          { server: app.server, resourceUri: app.resourceUri, params },
          (view) =>
            samplingAllowed.current.has(key)
              ? Promise.resolve(true)
              : ask(
                  { appId: app.id, server: app.server, kind: 'sampling', sampling: view },
                  signal,
                  { app: key },
                ),
          signal,
        )
      } catch (err) {
        // The core's refusals carry the code the app is told (-1: the user said no).
        throw appSamplingErrorOf(err)
      }
    },
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

  const samplingOn = sampling && Boolean(sampleFn)
  return useMemo(
    () => ({
      connected: Boolean(connection),
      read,
      tool,
      callTool,
      openLink,
      message,
      ...(downloads ? { downloadFile } : {}),
      ...(samplingOn ? { sample } : {}),
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
      downloads,
      downloadFile,
      samplingOn,
      sample,
      requests,
      answer,
      draft,
      isWaiting,
      sandboxSetting,
    ],
  )
}
