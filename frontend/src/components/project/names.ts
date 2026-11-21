import { useMemo } from 'react'
import { useSubcontractors } from '../subcontract/useSubcontractors'

export type SubName = { name: string; trade?: string }

/** catalogue id → name and trade. Demo names (`?demo=workflow`) fill in where the catalogue knows nothing. */
export function useSubNames(enabled: boolean, demo?: Record<string, SubName>) {
  const subs = useSubcontractors(enabled)
  const map = useMemo(() => {
    const out = new Map<string, SubName>(Object.entries(demo ?? {}))
    for (const row of subs.rows) out.set(row.id, { name: row.name, trade: row.trade })
    return out
  }, [subs.rows, demo])
  return (id: string): SubName => map.get(id) ?? { name: id }
}

/** "dd.mm.yy" for a card; empty for a missing or unreadable date */
export function shortDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })
}
