/**
 * Shared workspace sync. Every browser keeps a local copy (zustand + localStorage) and exchanges
 * record-level changes with /api/workspace/state, so edits made anywhere reach everyone.
 *
 * `sync.hashes` remembers what the server had at the last exchange. A record whose local hash differs
 * from it was changed here; a remembered record missing locally was deleted here. Everything else is
 * taken from the server, so concurrent edits to different records merge.
 */
import { useStore, type SyncBase } from './store'
import { forgetUserList } from './data'
import { withoutLegacyImports } from './legacy'

export const SYNCED = [
  'userFolders', 'userLists', 'userDocuments', 'documentLinks', 'documentFolders',
  'folderPatch', 'listPatch', 'edits', 'stats',
] as const
type Collection = (typeof SYNCED)[number]
const ARRAYS = new Set<Collection>(['userFolders', 'userLists', 'userDocuments'])
type Records = Record<string, unknown>
type Maps = Record<Collection, Records>
type Changes = Partial<Record<Collection, { set?: Records; delete?: string[] }>>

const API = '/api/workspace/state'
const PUSH_DELAY = 700
const POLL_EVERY = 4000

/* ---------------------------- record helpers ---------------------------- */

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : canonical(item))).join(',')}]`
  const entries = Object.entries(value as Records).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : 1))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}

const hashCache = new WeakMap<object, string>()
function hash(value: unknown): string {
  if (value !== null && typeof value === 'object' && hashCache.has(value)) return hashCache.get(value)!
  const text = canonical(value)
  let h1 = 0xdeadbeef ^ text.length
  let h2 = 0x41c6ce57 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const out = `${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`
  if (value !== null && typeof value === 'object') hashCache.set(value, out)
  return out
}

type SyncedState = Pick<ReturnType<typeof useStore.getState>, Collection>

function toMaps(state: SyncedState): Maps {
  const maps = {} as Maps
  for (const name of SYNCED) {
    const value = state[name] as unknown
    maps[name] = ARRAYS.has(name)
      ? Object.fromEntries((value as { id: string }[]).map((record) => [record.id, record]))
      : { ...(value as Records) }
  }
  return maps
}

/** back to store shape; arrays keep the local order and append new records */
function fromMaps(maps: Maps, previous: SyncedState): SyncedState {
  const out = {} as Record<Collection, unknown>
  for (const name of SYNCED) {
    if (!ARRAYS.has(name)) {
      out[name] = maps[name]
      continue
    }
    const records = maps[name]
    const known = (previous[name] as { id: string }[]).map((record) => record.id).filter((id) => id in records)
    const seen = new Set(known)
    out[name] = [...known, ...Object.keys(records).filter((id) => !seen.has(id))].map((id) => records[id])
  }
  return out as SyncedState
}

function hashesOf(maps: Maps): SyncBase['hashes'] {
  return Object.fromEntries(SYNCED.map((name) => [name, Object.fromEntries(Object.entries(maps[name]).map(([id, v]) => [id, hash(v)]))]))
}

/** local edits since the last exchange; without a base only records the server lacks are sent */
function localChanges(local: Maps, remote: Maps | null, base: SyncBase | null): Changes {
  const changes: Changes = {}
  for (const name of SYNCED) {
    const known = base?.hashes[name] ?? {}
    const set: Records = {}
    for (const [id, value] of Object.entries(local[name])) {
      const changed = base ? known[id] !== hash(value) : !remote || !(id in remote[name])
      if (changed) set[id] = value
    }
    const removed = base ? Object.keys(known).filter((id) => !(id in local[name])) : []
    if (Object.keys(set).length || removed.length) changes[name] = { set, delete: removed }
  }
  return changes
}

function applyChanges(maps: Maps, changes: Changes): Maps {
  const out = { ...maps }
  for (const [name, change] of Object.entries(changes) as [Collection, NonNullable<Changes[Collection]>][]) {
    const records = { ...out[name], ...change.set }
    for (const id of change.delete ?? []) delete records[id]
    out[name] = records
  }
  return out
}

const isEmpty = (changes: Changes) => Object.keys(changes).length === 0

/* --------------------------------- engine --------------------------------- */

let queue: Promise<unknown> = Promise.resolve()
let pushTimer: ReturnType<typeof setTimeout> | undefined
let applying = false
let started = false

function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => undefined)
  return next
}

async function request(init?: RequestInit, since?: number) {
  const url = since === undefined ? API : `${API}?since=${since}`
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...init })
  if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) {
    throw new Error(`Workspace sync failed (HTTP ${response.status})`)
  }
  return (await response.json()) as { revision: number; unchanged?: boolean; collections?: Partial<Maps> }
}

/** merged records, reusing local objects that did not change so views keep their references */
function settle(merged: Maps, local: Maps, previous: SyncedState): Partial<SyncedState> {
  const stable = {} as Maps
  const changed: Collection[] = []
  for (const name of SYNCED) {
    const records: Records = {}
    let same = Object.keys(merged[name]).length === Object.keys(local[name]).length
    for (const [id, value] of Object.entries(merged[name])) {
      const mine = local[name][id]
      const keep = id in local[name] && (mine === value || hash(mine) === hash(value))
      records[id] = keep ? mine : value
      same &&= keep
    }
    stable[name] = records
    if (!same) changed.push(name)
  }
  const shaped = fromMaps(stable, previous)
  return Object.fromEntries(changed.map((name) => [name, shaped[name]]))
}

function receive(revision: number, collections: Partial<Maps>) {
  const state = useStore.getState()
  const remote = Object.fromEntries(SYNCED.map((name) => [name, collections[name] ?? {}])) as Maps
  const local = toMaps(state)
  const merged = toMaps({ ...state, ...withoutLegacyImports(fromMaps(applyChanges(remote, localChanges(local, remote, state.sync)), state)) })
  const next = settle(merged, local, state)
  for (const list of next.userLists ?? []) {
    if (local.userLists[list.id] && local.userLists[list.id] !== list) forgetUserList(list.id)
  }
  applying = true
  try {
    useStore.setState({ ...next, sync: { revision, hashes: hashesOf(remote) } })
  } finally {
    applying = false
  }
}

function pull() {
  return serial(async () => {
    const since = useStore.getState().sync?.revision
    const body = await request(undefined, since)
    if (!body.unchanged && body.collections) receive(body.revision, body.collections)
  })
}

function push() {
  return serial(async () => {
    const state = useStore.getState()
    if (!state.sync) return // the first pull decides what is new here
    const changes = localChanges(toMaps(state), null, state.sync)
    if (isEmpty(changes)) return
    const body = await request({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes }),
    })
    if (body.collections) receive(body.revision, body.collections)
  })
}

function schedulePush() {
  clearTimeout(pushTimer)
  pushTimer = setTimeout(() => void push().catch(report), PUSH_DELAY)
}

let lastError = 0
function report(error: unknown) {
  // Offline or no backend (e.g. a static preview): keep working locally and retry on the next tick.
  if (Date.now() - lastError > 60_000) console.warn(error)
  lastError = Date.now()
}

export function startSync() {
  if (started) return
  started = true
  useStore.subscribe((state, previous) => {
    if (applying || !SYNCED.some((name) => state[name] !== previous[name])) return
    schedulePush()
  })
  const tick = () => {
    if (document.visibilityState !== 'visible') return
    void pull().then(push).catch(report)
  }
  tick()
  setInterval(tick, POLL_EVERY)
  window.addEventListener('focus', tick)
  document.addEventListener('visibilitychange', tick)
  // flush pending edits when the tab is closed
  window.addEventListener('pagehide', () => {
    const state = useStore.getState()
    if (!state.sync) return
    const changes = localChanges(toMaps(state), null, state.sync)
    if (!isEmpty(changes)) {
      void fetch(API, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes }) }).catch(() => undefined)
    }
  })
}

/** test hook */
export const __sync = { pull, push }
