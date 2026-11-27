import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { VirtualFileSystem } from '@dudko.dev/agent-web'
import { FileChips, type WrittenFileView } from '../../dist/index.js'

/**
 * A TEST-ONLY page: `<FileChips>` over a workspace the test fills, with the HTML preview's
 * scripts ON - the mode the demo does not ship, and the worst case for the sandboxed frame.
 *
 * Not part of the demo, not part of any published package and never deployed: `page-server.ts`
 * bundles this file when the browser test starts and serves it on loopback for that test alone.
 *
 * The page holds what a real host holds and an untrusted document must never reach: a value in
 * `localStorage`, an IndexedDB database, a cookie, a secret in its DOM and on `window`. The test
 * then previews hostile documents and reads back what they managed to do.
 */

export interface FilesPageApi {
  /** Write the documents into the workspace and show their chips. */
  show: (docs: { path: string; html: string }[], options: { scripts: boolean }) => Promise<void>
}

export const HOST_SECRET = 'HOST-SECRET-9d2f'

let root: Root | undefined

const seed = async (): Promise<void> => {
  localStorage.setItem('vault-key', HOST_SECRET)
  sessionStorage.setItem('vault-key', HOST_SECRET)
  document.cookie = `vault=${HOST_SECRET}; path=/`
  ;(window as unknown as { hostSecret: string }).hostSecret = HOST_SECRET
  const p = document.createElement('p')
  p.id = 'host-secret'
  p.textContent = HOST_SECRET
  document.body.appendChild(p)
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('host-vault', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('keys')
    open.onsuccess = () => {
      const tx = open.result.transaction('keys', 'readwrite')
      tx.objectStore('keys').put(HOST_SECRET, 'api-key')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    }
    open.onerror = () => reject(open.error)
  })
}

const api: FilesPageApi = {
  show: async (docs, { scripts }) => {
    const vfs = new VirtualFileSystem({ memory: true })
    const written: WrittenFileView[] = []
    for (const doc of docs) {
      const info = await vfs.write(doc.path, doc.html)
      written.push({ path: info.path, mediaType: info.mimeType, bytes: info.size, writes: 1 })
    }
    root?.unmount()
    const host = document.createElement('div')
    host.id = 'chips'
    host.className = 'awr-theme'
    document.getElementById('chips')?.remove()
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(createElement(FileChips, { written, files: vfs, htmlPreview: { scripts } }))
  },
}

void seed().then(() => {
  ;(window as unknown as { filesPage: FilesPageApi }).filesPage = api
  const status = document.getElementById('status')
  if (status) status.textContent = 'ready'
})
