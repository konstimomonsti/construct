import type { Library, ListDoc } from './types'
import { useStore } from './store'

const base = import.meta.env.BASE_URL

export class NotFoundError extends Error {
  readonly notFound = true
  constructor(what: string) {
    super(`${what} not found`)
    this.name = 'NotFoundError'
  }
}

async function getJson<T>(url: string, what: string): Promise<T> {
  const r = await fetch(url)
  const ct = r.headers.get('content-type') ?? ''
  // Vite's SPA fallback answers unknown paths with index.html (200)
  if (r.status === 404 || !ct.includes('json')) throw new NotFoundError(what)
  if (!r.ok) throw new Error(`${what}: HTTP ${r.status}`)
  return (await r.json()) as T
}

let libraryPromise: Promise<Library> | null = null
export function loadLibrary(): Promise<Library> {
  libraryPromise ??= getJson<Library>(`${base}data/index.json`, 'Library')
    .then((lib) => {
      useStore.getState().setBase(lib)
      return lib
    })
    .catch((e) => {
      libraryPromise = null
      throw e
    })
  return libraryPromise
}

const listCache = new Map<string, Promise<ListDoc>>()
/** cached promise per list — safe to pass to React's use() */
export function loadList(id: string): Promise<ListDoc> {
  const user = useStore.getState().userLists.find((l) => l.id === id)
  if (user) {
    const key = `user:${id}`
    if (!listCache.has(key)) listCache.set(key, Promise.resolve(user))
    return listCache.get(key)!
  }
  let p = listCache.get(id)
  if (!p) {
    // Rejections stay cached: React's use() re-renders on every new promise, so
    // evicting here caused an endless refetch loop. Retry goes through resetLoaders().
    p = getJson<ListDoc>(`${base}data/lists/${encodeURIComponent(id)}.json`, 'List')
    listCache.set(id, p)
  }
  return p
}

export function resetLoaders() {
  libraryPromise = null
  listCache.clear()
}

export const fileUrl = (rel?: string) => (rel ? `${base}${rel}` : undefined)

export const docUrl = (d: { blobUrl?: string; file: string }) => d.blobUrl ?? fileUrl(d.file) ?? ''
