import { serverReachable } from './server'

const storeName = 'files'

function openDocuments(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('billbuild-documents', 1)
    request.onupgradeneeded = () => request.result.createObjectStore(storeName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function writeDocuments(write: (store: IDBObjectStore) => void) {
  const db = await openDocuments()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error)
      write(transaction.objectStore(storeName))
    })
  } finally {
    db.close()
  }
}

const FILES = '/api/workspace/file'

/** keep a local copy and share the file with the workspace */
export async function saveDocument(id: string, file: File) {
  const type = /\.pdf$/i.test(file.name) ? 'application/pdf' : 'application/octet-stream'
  const blob = file.slice(0, file.size, type)
  await writeDocuments((store) => store.put(blob, id))
  try {
    // without a backend the upload would hang the import (see lib/server.ts); the local copy is enough for now
    if (!await serverReachable()) throw new Error('the server is not reachable')
    const response = await fetch(`${FILES}?id=${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': type }, body: blob })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  } catch (error) {
    // Still usable in this browser; other browsers cannot open it until it is uploaded again.
    console.warn(`Could not share ${file.name} with the workspace`, error)
  }
}

/** local copy first, then the shared workspace (cached locally afterwards) */
export async function loadDocument(id: string): Promise<Blob | undefined> {
  const local = await loadLocalDocument(id).catch(() => undefined)
  if (local) return local
  const response = await fetch(`${FILES}?id=${encodeURIComponent(id)}`)
  if (!response.ok) return undefined
  const blob = await response.blob()
  void writeDocuments((store) => store.put(blob, id)).catch(() => undefined)
  return blob
}

async function loadLocalDocument(id: string): Promise<Blob | undefined> {
  const db = await openDocuments()
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(storeName).objectStore(storeName).get(id)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

export function removeDocuments(ids: string[]) {
  if (!ids.length) return
  void writeDocuments((store) => ids.forEach((id) => store.delete(id))).catch(console.error)
  void fetch(`${FILES}-delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }).catch(() => undefined)
}

export function clearDocuments() {
  return writeDocuments((store) => store.clear())
}
