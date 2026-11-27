import type { ToolSet } from 'ai'
import { fileToolBindingOf } from '../files/tools.js'
import {
  isTextMime,
  normalizePath,
  type VirtualFileInfo,
  type VirtualFileSystem,
} from '../files/vfs.js'
import {
  moduleSpecifiersOf,
  resolveModulePath,
  SANDBOX_MAX_FILE_CHARS,
  SANDBOX_MAX_MODULE_CHARS_TOTAL,
  SANDBOX_MAX_MODULES,
  SANDBOX_MODULE_EXTENSIONS,
  type SandboxHostCall,
  type SandboxHostOp,
} from './engine.js'

/**
 * The workspace a sandbox is bound to: the virtual file system the agent's own file tools work
 * on, and - per operation - the NAME of the tool that grants it. The guest gets an operation
 * only when the agent has the tool for it (a read-only mount gives no `writeFile`), and every
 * call passes the consent gate under that tool's name, so a rule that denies `fs_write` denies
 * the guest's writes too.
 */
export interface SandboxFiles {
  vfs: VirtualFileSystem
  read?: string
  write?: string
  list?: string
}

/** The agent's consent gate, as a tool reaches it (`ToolRunContext.approve`). */
export type SandboxApprove = (toolName: string, input: unknown, readOnly: boolean) => Promise<void>

/** Find the file tools among the mounted tools (the first file system that can be read wins). */
export const sandboxFilesOf = (tools: ToolSet): SandboxFiles | undefined => {
  let files: SandboxFiles | undefined
  for (const [name, t] of Object.entries(tools)) {
    const binding = fileToolBindingOf(t)
    if (!binding || binding.op === 'delete') continue
    if (!files) files = { vfs: binding.vfs }
    if (files.vfs !== binding.vfs) continue
    files[binding.op] ??= name
  }
  return files && (files.read || files.write || files.list) ? files : undefined
}

export const sandboxHostOps = (files: SandboxFiles): SandboxHostOp[] => [
  ...(files.read ? (['readFile'] as const) : []),
  ...(files.write ? (['writeFile'] as const) : []),
  ...(files.list ? (['readdir'] as const) : []),
]

const pathOf = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(`${what}: a path (string) is required`)
  // Throws on a path that climbs out of the root; there is nothing above it to reach.
  return normalizePath(value)
}

/** Read one workspace file as text, under the same rules as `fs_read` plus a size cap. */
export const readWorkspaceText = async (
  files: SandboxFiles,
  path: string,
  approve: SandboxApprove | undefined,
  maxChars: number,
): Promise<string> => {
  if (!files.read) throw new Error('reading files is not available in this sandbox')
  await approve?.(files.read, { path }, true)
  const f = await files.vfs.read(path)
  if (!f) throw new Error(`no file "${path}"`)
  if (f.encoding === 'base64' && !isTextMime(f.mimeType)) {
    throw new Error(`"${path}" is a binary file (${f.mimeType}) and cannot be read as text`)
  }
  const text = f.encoding === 'base64' ? atob(f.content) : f.content
  if (text.length > maxChars) {
    throw new Error(`"${path}" is ${text.length} characters; the sandbox reads at most ${maxChars}`)
  }
  return text
}

/** Serves the guest's `fs` calls on the agent's side of the boundary. */
export const createFileHost =
  (
    files: SandboxFiles,
    approve: SandboxApprove | undefined,
    /** Told about every file the guest wrote, after the write succeeded (the run's `file.written`). */
    onWrite?: (file: VirtualFileInfo) => void,
  ): SandboxHostCall =>
  async (op, args) => {
    switch (op) {
      case 'readFile':
        return readWorkspaceText(
          files,
          pathOf(args[0], 'fs.readFile'),
          approve,
          SANDBOX_MAX_FILE_CHARS,
        )
      case 'writeFile': {
        if (!files.write) throw new Error('writing files is not available in this sandbox')
        const path = pathOf(args[0], 'fs.writeFile')
        const content = args[1]
        if (typeof content !== 'string')
          throw new Error('fs.writeFile: the content must be a string')
        if (content.length > SANDBOX_MAX_FILE_CHARS) {
          throw new Error(
            `fs.writeFile: ${content.length} characters; the sandbox writes at most ${SANDBOX_MAX_FILE_CHARS}`,
          )
        }
        await approve?.(files.write, { path, content }, false)
        const info = await files.vfs.write(path, content)
        onWrite?.(info)
        return undefined
      }
      case 'readdir': {
        if (!files.list) throw new Error('listing files is not available in this sandbox')
        const prefix =
          args[0] === undefined || args[0] === '/' ? '/' : pathOf(args[0], 'fs.readdir')
        await approve?.(files.list, { prefix }, true)
        return (await files.vfs.list(prefix)).map((f) => f.path)
      }
      default:
        throw new Error(`fs.${String(op).slice(0, 40)} is not available in this sandbox`)
    }
  }

/**
 * The workspace modules a program refers to, by literal path, followed through their own
 * imports: what the guest's loader will be able to load. A file that is missing, too large, of
 * another kind, or outside the root is simply not handed over - the guest's `import` of it then
 * fails with the reason. Bounded in count and total size.
 */
export const collectModules = async (
  files: SandboxFiles,
  code: string,
  filename: string,
  approve: SandboxApprove | undefined,
  maxModuleChars: number,
): Promise<Record<string, string>> => {
  const modules: Record<string, string> = {}
  if (!files.read) return modules
  const seen = new Set<string>()
  const queue: { source: string; base: string }[] = [{ source: code, base: filename }]
  let total = 0
  while (queue.length > 0) {
    const { source, base } = queue.shift() as { source: string; base: string }
    for (const spec of moduleSpecifiersOf(source)) {
      let path: string
      try {
        path = normalizePath(resolveModulePath(base, spec))
      } catch {
        continue
      }
      if (seen.has(path)) continue
      seen.add(path)
      if (!SANDBOX_MODULE_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext))) continue
      if (seen.size > SANDBOX_MAX_MODULES) return modules
      let text: string
      try {
        text = await readWorkspaceText(files, path, approve, maxModuleChars)
      } catch {
        continue
      }
      if (total + text.length > SANDBOX_MAX_MODULE_CHARS_TOTAL) continue
      total += text.length
      modules[path] = text
      if (!path.toLowerCase().endsWith('.json')) queue.push({ source: text, base: path })
    }
  }
  return modules
}
