import { useEffect, useMemo, useState } from 'react'
import { parseLineType, type LineType } from './line-type'
import type { Position } from './types'

const BATCH_SIZE = 24

function descriptionKey(position: Position) {
  const short = position.short.trim().slice(0, 500)
  const long = position.long?.trim().slice(0, 6000) ?? ''
  return (short && short !== '(ohne Kurztext)') || long ? JSON.stringify([short, long]) : null
}

export function useLineTypes(positions: Position[]): Map<string, LineType> {
  const [known, setKnown] = useState(() => new Map<string, LineType>())
  const candidates = useMemo(() => positions.flatMap((position) => {
    if (position.lineType && position.lineType !== 'automatic') return []
    const key = descriptionKey(position)
    return key ? [[position.id, key] as const] : []
  }), [positions])
  const signature = useMemo(() => JSON.stringify([...new Set(candidates.map(([, key]) => key))].sort()), [candidates])

  useEffect(() => {
    const controller = new AbortController()
    async function classify() {
      const keys: string[] = JSON.parse(signature)
      const pending = keys.filter((key) => !known.has(key))
      for (let start = 0; start < pending.length; start += BATCH_SIZE) {
        const batch = pending.slice(start, start + BATCH_SIZE)
        const lines = batch.map((key) => {
          const [short, long] = JSON.parse(key)
          return { short, long }
        })
        try {
          const response = await fetch('/api/workspace/line-types', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lines }), signal: controller.signal,
          })
          if (!response.ok) return
          const result = await response.json()
          if (result?.status !== 'ready' || !Array.isArray(result.types) || result.types.length !== batch.length) return
          const types: unknown[] = result.types
          const labels = types.map(parseLineType).filter((label): label is LineType => !!label && label !== 'automatic')
          if (controller.signal.aborted || labels.length !== batch.length) return
          setKnown((previous) => {
            const next = new Map(previous)
            batch.forEach((key, index) => next.set(key, labels[index]))
            return next
          })
        } catch {
          return
        }
      }
    }
    void classify()
    return () => controller.abort()
    // Each run captures the known labels for the current description set.
  }, [signature]) // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => {
    const byPosition = new Map<string, LineType>()
    for (const [id, key] of candidates) {
      const label = known.get(key)
      if (label) byPosition.set(id, label)
    }
    return byPosition
  }, [candidates, known])
}
