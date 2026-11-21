import type { Position } from './types'
import { includedPositionTotal, round2, sumPositionTotals } from './money'

export type DiffKind = 'price_added' | 'price_changed' | 'qty_changed' | 'text_changed' | 'added' | 'removed'

export interface PositionDiff {
  positionId: string
  oz: string
  kinds: DiffKind[]
  oldUp: number | null
  newUp: number | null
  oldQty: number
  newQty: number
  oldShort: string
  newShort: string
  oldTotal: number
  newTotal: number
  deltaTotal: number
}

export interface ListDiff {
  baselineTotal: number
  currentTotal: number
  deltaTotal: number
  pctChange: number
  pricesAdded: number
  pricesChanged: number
  qtysChanged: number
  textsChanged: number
  linesAdded: number
  linesRemoved: number
  totalChanges: number
  byPositionId: Map<string, PositionDiff>
  diffs: PositionDiff[]
}

type IdentityMode = 'same-list' | 'linked-revisions'

export function diffLists(baselinePositions: Position[], currentPositions: Position[], identity: IdentityMode = 'same-list'): ListDiff {
  const keyOf = (position: Position) => identity === 'linked-revisions' ? position.positionKey : position.id
  const index = (positions: Position[]) => {
    const byKey = new Map<string, Position[]>()
    for (const position of positions) {
      const key = keyOf(position)
      if (!key) continue
      const matches = byKey.get(key) ?? []
      matches.push(position)
      byKey.set(key, matches)
    }
    return byKey
  }
  const baseline = index(baselinePositions)
  const current = index(currentPositions)
  const matchedCurToBase = new Map<Position, Position>()
  const matchedBase = new Set<Position>()
  for (const [key, matches] of current) {
    const prior = baseline.get(key)
    if (matches.length === 1 && prior?.length === 1) {
      matchedCurToBase.set(matches[0], prior[0])
      matchedBase.add(prior[0])
    }
  }

  const diffs: PositionDiff[] = []
  const byPositionId = new Map<string, PositionDiff>()

  let pricesAdded = 0
  let pricesChanged = 0
  let qtysChanged = 0
  let textsChanged = 0
  let linesAdded = 0
  let linesRemoved = 0

  // Check positions in current (modified) vs baseline
  for (const cur of currentPositions) {
    const base = matchedCurToBase.get(cur)
    if (!base) {
      linesAdded++
      const newTot = includedPositionTotal(cur)
      const diff: PositionDiff = {
        positionId: cur.id,
        oz: cur.oz,
        kinds: ['added'],
        oldUp: null,
        newUp: cur.up,
        oldQty: 0,
        newQty: cur.qty,
        oldShort: '',
        newShort: cur.short,
        oldTotal: 0,
        newTotal: newTot,
        deltaTotal: newTot,
      }
      diffs.push(diff)
      byPositionId.set(cur.id, diff)
      continue
    }

    const kinds: DiffKind[] = []
    if (base.up === null && cur.up !== null) {
      kinds.push('price_added')
      pricesAdded++
    } else if (base.up !== null && cur.up !== null && Math.abs(base.up - cur.up) > 0.001) {
      kinds.push('price_changed')
      pricesChanged++
    }

    if (Math.abs(base.qty - cur.qty) > 0.0001) {
      kinds.push('qty_changed')
      qtysChanged++
    }

    if (base.short.trim() !== cur.short.trim()) {
      kinds.push('text_changed')
      textsChanged++
    }

    if (kinds.length > 0) {
      const oldTot = includedPositionTotal(base)
      const newTot = includedPositionTotal(cur)
      const diff: PositionDiff = {
        positionId: cur.id,
        oz: cur.oz,
        kinds,
        oldUp: base.up,
        newUp: cur.up,
        oldQty: base.qty,
        newQty: cur.qty,
        oldShort: base.short,
        newShort: cur.short,
        oldTotal: oldTot,
        newTotal: newTot,
        deltaTotal: round2(newTot - oldTot),
      }
      diffs.push(diff)
      byPositionId.set(cur.id, diff)
    }
  }

  // Check for removed positions
  for (const base of baselinePositions) {
    if (!matchedBase.has(base)) {
      linesRemoved++
      const oldTot = includedPositionTotal(base)
      const diff: PositionDiff = {
        positionId: base.id,
        oz: base.oz,
        kinds: ['removed'],
        oldUp: base.up,
        newUp: null,
        oldQty: base.qty,
        newQty: 0,
        oldShort: base.short,
        newShort: '',
        oldTotal: oldTot,
        newTotal: 0,
        deltaTotal: -oldTot,
      }
      diffs.push(diff)
      byPositionId.set(base.id, diff)
    }
  }

  const baselineTotal = sumPositionTotals(baselinePositions)
  const currentTotal = sumPositionTotals(currentPositions)
  const deltaTotal = round2(currentTotal - baselineTotal)
  const pctChange = baselineTotal > 0 ? Math.round(((currentTotal - baselineTotal) / baselineTotal) * 1000) / 10 : 0

  return {
    baselineTotal,
    currentTotal,
    deltaTotal,
    pctChange,
    pricesAdded,
    pricesChanged,
    qtysChanged,
    textsChanged,
    linesAdded,
    linesRemoved,
    totalChanges: diffs.length,
    byPositionId,
    diffs,
  }
}
