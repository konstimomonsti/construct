/**
 * resolveList — single source of truth for "the list as the user currently sees it".
 * Applies all user edits (qty/up/patch/removed/added/moves/category changes) to a ListDoc
 * and returns final positions (with renumbered OZ + path for moved items) and the category tree.
 *
 * CONTRACT (used by the ledger UI, split overlay and every exporter):
 *   resolveList(doc, edits?) => { positions: Position[]; tree: CategoryNode[] }
 *   - positions are in tree order; each has `oz`, `path`, `category` consistent with `tree`
 *   - moved positions get the next free OZ inside their target category (same step & width
 *     as siblings), untouched positions keep their original OZ
 *
 * Pure module: no store / DOM access at runtime (safe to import from Node scripts).
 */
import type { CategoryNode, CategoryRef, ListDoc, Position } from './types'
import type { ListEdits } from './store'
import { flatTree, newNode, treeFromPaths } from './cat'
import { positionTotal } from './money'

export interface ResolvedList {
  positions: Position[]
  tree: CategoryNode[]
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export function naturalCompare(a: string, b: string): number {
  const x = a.split('.')
  const y = b.split('.')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i]
    const q = y[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const n = parseInt(p, 10)
    const m = parseInt(q, 10)
    if (Number.isFinite(n) && Number.isFinite(m) && String(n) === p.replace(/^0+(?=\d)/, '') && String(m) === q.replace(/^0+(?=\d)/, '')) {
      if (n !== m) return n - m
    } else if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

export const cloneTree = (t: CategoryNode[]): CategoryNode[] => t.map((n) => ({ ...n, children: cloneTree(n.children) }))

export interface TreeIndex {
  node: Map<string, CategoryNode>
  parent: Map<string, CategoryNode | null>
  order: Map<string, number>
}

export function indexTree(tree: CategoryNode[]): TreeIndex {
  const node = new Map<string, CategoryNode>()
  const parent = new Map<string, CategoryNode | null>()
  const order = new Map<string, number>()
  let i = 0
  const walk = (list: CategoryNode[], par: CategoryNode | null) => {
    for (const n of list) {
      node.set(n.oz, n)
      parent.set(n.oz, par)
      order.set(n.oz, i++)
      walk(n.children, n)
    }
  }
  walk(tree, null)
  return { node, parent, order }
}

export const leafOz = (p: Pick<Position, 'path'>): string => p.path?.[p.path.length - 1]?.oz ?? ''

export function pathOf(idx: TreeIndex, oz: string): CategoryRef[] {
  const out: CategoryRef[] = []
  let n = idx.node.get(oz) ?? null
  while (n) {
    out.unshift({ oz: n.oz, label: n.label })
    n = idx.parent.get(n.oz) ?? null
  }
  return out
}

const lastPart = (oz: string) => {
  const i = oz.lastIndexOf('.')
  return { prefix: i < 0 ? '' : oz.slice(0, i), last: i < 0 ? oz : oz.slice(i + 1) }
}
const numOf = (s: string) => {
  const n = parseInt(s, 10)
  return Number.isFinite(n) ? n : 0
}
const minStep = (nums: number[]): number | null => {
  const s = [...new Set(nums)].sort((a, b) => a - b)
  let best: number | null = null
  for (let i = 1; i < s.length; i++) {
    const d = s[i] - s[i - 1]
    if (d > 0 && (best === null || d < best)) best = d
  }
  return best
}
const pad = (n: number, width: number) => (width > 0 ? String(n).padStart(width, '0') : String(n))
const mostCommon = <T,>(arr: T[]): T | undefined => {
  const m = new Map<T, number>()
  let best: T | undefined
  let bc = 0
  for (const a of arr) {
    const c = (m.get(a) ?? 0) + 1
    m.set(a, c)
    if (c > bc) {
      bc = c
      best = a
    }
  }
  return best
}

/** typical step between consecutive position numbers (10 for 1.1.10, 1.1.20 …) */
export function globalStep(positions: Pick<Position, 'oz'>[]): number {
  const byPrefix = new Map<string, number[]>()
  for (const p of positions) {
    const { prefix, last } = lastPart(p.oz)
    if (!/^\d+$/.test(last)) continue
    const l = byPrefix.get(prefix) ?? []
    l.push(numOf(last))
    byPrefix.set(prefix, l)
  }
  const steps: number[] = []
  for (const l of byPrefix.values()) {
    const s = minStep(l)
    if (s) steps.push(s)
  }
  return mostCommon(steps) ?? 10
}

/** next free position OZ inside a category (same prefix, step and zero padding as its siblings) */
export function nextPositionOz(catOz: string, siblingOzs: string[], taken: Set<string>, gstep: number): string {
  const parts = siblingOzs.map(lastPart).filter((p) => /^\d+$/.test(p.last))
  const prefix = parts.length ? (mostCommon(parts.map((p) => p.prefix)) as string) : catOz
  const mine = parts.filter((p) => p.prefix === prefix)
  const width = mine.some((p) => p.last.length > 1 && p.last.startsWith('0')) ? Math.max(...mine.map((p) => p.last.length)) : 0
  const nums = mine.map((p) => numOf(p.last))
  const step = minStep(nums) ?? gstep
  let next = (nums.length ? Math.max(...nums) : 0) + step
  const make = (n: number) => (prefix ? `${prefix}.${pad(n, width)}` : pad(n, width))
  while (taken.has(make(next))) next += step
  return make(next)
}

/** next free child category OZ under parentOz (null = root level) */
export function nextChildOz(tree: CategoryNode[], parentOz: string | null): string {
  const idx = indexTree(tree)
  const sibs = parentOz ? (idx.node.get(parentOz)?.children ?? []) : tree
  const parts = sibs.map((c) => lastPart(c.oz))
  const width = parts.some((p) => p.last.length > 1 && p.last.startsWith('0')) ? Math.max(...parts.map((p) => p.last.length)) : 0
  const nums = parts.map((p) => numOf(p.last))
  const step = minStep(nums) ?? 1
  let next = (nums.length ? Math.max(...nums) : 0) + step
  const make = (n: number) => (parentOz ? `${parentOz}.${pad(n, width)}` : pad(n, width))
  while (idx.node.has(make(next))) next += step
  return make(next)
}

export interface MoveChange {
  from: string
  to: string
  target: string
}

/** pure move/renumber step shared by resolveList and the split overlay preview */
export function applyMoves(
  positions: Position[],
  tree: CategoryNode[],
  moves: Iterable<[string, string]>,
): { positions: Position[]; changes: Map<string, MoveChange> } {
  const idx = indexTree(tree)
  const taken = new Set(positions.map((p) => p.oz))
  const gstep = globalStep(positions)
  const out = new Map<string, Position>()
  const byId = new Map(positions.map((p) => [p.id, p]))
  const changes = new Map<string, MoveChange>()
  for (const [pid, target] of moves) {
    const p = out.get(pid) ?? byId.get(pid)
    const node = idx.node.get(target)
    if (!p || !node) continue
    if (leafOz(p) === target) continue
    const sibs: string[] = []
    for (const x of positions) {
      const cur = out.get(x.id) ?? x
      if (cur.id !== pid && leafOz(cur) === target) sibs.push(cur.oz)
    }
    const oz = nextPositionOz(target, sibs, taken, gstep)
    taken.add(oz)
    const path = pathOf(idx, target)
    out.set(pid, { ...p, oz, path, category: node.label, group: path[0]?.label })
    changes.set(pid, { from: changes.get(pid)?.from ?? p.oz, to: oz, target })
  }
  return { positions: positions.map((p) => out.get(p.id) ?? p), changes }
}

export interface CatStat {
  count: number
  total: number
  pids: string[]
  /** positions with quantity 0, and positions without a unit price */
  zero: number
  unpriced: number
}

/** per-category aggregates (a position counts for every category on its path) */
export function treeStats(positions: Position[]): Map<string, CatStat> {
  const m = new Map<string, CatStat>()
  for (const p of positions) {
    const t = positionTotal(p)
    for (const r of p.path ?? []) {
      let s = m.get(r.oz)
      if (!s) m.set(r.oz, (s = { count: 0, total: 0, pids: [], zero: 0, unpriced: 0 }))
      s.count++
      if (p.up == null) s.unpriced++
      else if (!p.qty) s.zero++
      s.total += t
      s.pids.push(p.id)
    }
  }
  return m
}

/** subset of a tree containing only the given category OZs and their ancestors */
export function pruneTree(tree: CategoryNode[], keep: Set<string>): CategoryNode[] {
  const out: CategoryNode[] = []
  for (const n of tree) {
    const kids = pruneTree(n.children, keep)
    if (keep.has(n.oz) || kids.length) out.push({ ...n, children: kids })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* resolveList                                                         */
/* ------------------------------------------------------------------ */

const normE = (e?: Partial<ListEdits>): ListEdits => ({
  qty: e?.qty ?? {},
  up: e?.up ?? {},
  removed: e?.removed ?? [],
  added: e?.added ?? [],
  patch: e?.patch ?? {},
  moves: e?.moves ?? {},
  categories: { added: e?.categories?.added ?? [], renamed: e?.categories?.renamed ?? {} },
})

export function resolveList(doc: ListDoc, editsIn?: Partial<ListEdits>): ResolvedList {
  const e = normE(editsIn)
  const removed = new Set(e.removed)
  let base: Position[] = [...doc.positions, ...e.added]
    .filter((p) => !removed.has(p.id))
    .map((p) => {
      const q = e.qty[p.id]
      const up = p.id in e.up ? e.up[p.id] : p.up
      const patch = e.patch[p.id]
      return q === undefined && up === p.up && !patch ? p : { ...p, ...patch, qty: q ?? p.qty, up }
    })

  // ---- tree
  let tree = doc.tree?.length ? cloneTree(doc.tree) : treeFromPaths(base)
  let idx = indexTree(tree)
  const attach = (n: CategoryNode, parentOz: string | null) => {
    const parent = parentOz ? idx.node.get(parentOz) : undefined
    n.depth = (parent?.depth ?? 0) + 1
    ;(parent ? parent.children : tree).push(n)
    idx = indexTree(tree)
  }
  for (const c of e.categories.added) if (!idx.node.has(c.oz)) attach(newNode(c.oz, c.label), c.parentOz)
  // paths referencing categories missing from the tree
  for (const p of base) {
    let parent: string | null = null
    for (const r of p.path ?? []) {
      if (!idx.node.has(r.oz)) attach(newNode(r.oz, r.label), parent)
      parent = r.oz
    }
  }
  // positions without a category → match by label or create a synthetic root category
  const byLabel = new Map<string, string>()
  const walkLabels = (l: CategoryNode[]) => l.forEach((n) => (byLabel.has(n.label) || byLabel.set(n.label, n.oz), walkLabels(n.children)))
  walkLabels(tree)
  base = base.map((p) => {
    if (p.path?.length) return p
    const label = p.category || 'Allgemein'
    let oz = byLabel.get(label)
    if (!oz) {
      oz = nextChildOz(tree, null)
      attach(newNode(oz, label), null)
      byLabel.set(label, oz)
    }
    return { ...p, path: pathOf(idx, oz) }
  })
  for (const [oz, label] of Object.entries(e.categories.renamed)) {
    const n = idx.node.get(oz)
    if (n) n.label = label
  }

  // ---- moves (renumbering)
  const validMoves = Object.entries(e.moves)
  base = applyMoves(base, tree, validMoves).positions

  // ---- final paths/labels + tree order
  const decorated = base.map((p, i) => {
    const path = (p.path ?? []).map((r) => ({ oz: r.oz, label: idx.node.get(r.oz)?.label ?? r.label }))
    const leaf = path[path.length - 1]
    const q: Position = { ...p, oz: e.patch[p.id]?.oz ?? p.oz, path, category: leaf?.label ?? p.category, group: path[0]?.label ?? p.group }
    return { q, o: idx.order.get(leaf?.oz ?? '') ?? 1e9, i }
  })
  decorated.sort((a, b) => a.o - b.o || naturalCompare(a.q.oz, b.q.oz) || a.i - b.i)
  return { positions: decorated.map((d) => d.q), tree }
}

/** convenience for UI code that only has positions (no ListDoc) */
export function ensureTree(positions: Position[]): CategoryNode[] {
  const copy = positions.map((p) => ({ ...p }))
  return copy.every((p) => p.path?.length) ? treeFromPaths(copy) : flatTree(copy)
}
