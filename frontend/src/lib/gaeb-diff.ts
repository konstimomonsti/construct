import type { Position } from './types'
import { positionTotal } from './money'

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

function normOz(oz: string | undefined): string {
  if (!oz) return ''
  return oz.trim().split('.').map((p) => p.replace(/^0+(?=\d)/, '')).join('.')
}

export function diffLists(baselinePositions: Position[], currentPositions: Position[]): ListDiff {
  const baseMap = new Map<string, Position>()
  const baseByOz = new Map<string, Position[]>()
  for (const p of baselinePositions) {
    baseMap.set(p.id, p)
    const noz = normOz(p.oz)
    if (noz) {
      const arr = baseByOz.get(noz) ?? []
      arr.push(p)
      baseByOz.set(noz, arr)
    }
  }

  const curMap = new Map<string, Position>()
  const curByOz = new Map<string, Position[]>()
  for (const p of currentPositions) {
    curMap.set(p.id, p)
    const noz = normOz(p.oz)
    if (noz) {
      const arr = curByOz.get(noz) ?? []
      arr.push(p)
      curByOz.set(noz, arr)
    }
  }

  // Pre-match positions: first by direct ID, then by unambiguous normalized OZ
  const matchedCurToBase = new Map<string, Position>()
  const matchedBaseIds = new Set<string>()

  // 1. Direct ID match
  for (const cur of currentPositions) {
    if (baseMap.has(cur.id)) {
      const base = baseMap.get(cur.id)!
      matchedCurToBase.set(cur.id, base)
      matchedBaseIds.add(base.id)
    }
  }

  // 2. Unambiguous OZ match for remaining unmatched
  for (const cur of currentPositions) {
    if (matchedCurToBase.has(cur.id)) continue
    const noz = normOz(cur.oz)
    if (!noz) continue
    const baseCandidates = baseByOz.get(noz) ?? []
    const curCandidates = curByOz.get(noz) ?? []
    // Match only when unambiguous (exactly 1 candidate in each list)
    if (baseCandidates.length === 1 && curCandidates.length === 1) {
      const base = baseCandidates[0]
      if (!matchedBaseIds.has(base.id)) {
        matchedCurToBase.set(cur.id, base)
        matchedBaseIds.add(base.id)
      }
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
    const base = matchedCurToBase.get(cur.id)
    if (!base) {
      linesAdded++
      const newTot = positionTotal(cur)
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
      const oldTot = positionTotal(base)
      const newTot = positionTotal(cur)
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
        deltaTotal: Math.round((newTot - oldTot) * 100) / 100,
      }
      diffs.push(diff)
      byPositionId.set(cur.id, diff)
    }
  }

  // Check for removed positions
  for (const base of baselinePositions) {
    if (!matchedBaseIds.has(base.id)) {
      linesRemoved++
      const oldTot = positionTotal(base)
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

  const baselineTotal = Math.round(baselinePositions.reduce((s, p) => s + positionTotal(p), 0) * 100) / 100
  const currentTotal = Math.round(currentPositions.reduce((s, p) => s + positionTotal(p), 0) * 100) / 100
  const deltaTotal = Math.round((currentTotal - baselineTotal) * 100) / 100
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
