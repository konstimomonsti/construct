import clsx from 'clsx'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Icon, inputCls } from '../ui'
import type { CatalogueEntry } from '../../lib/catalogues'

/** step 2: who gets the request, from the subcontractor catalogue */
export function WhoPane({
  entries, loading, error, onRetry, selected, onChange, suggested,
}: {
  entries: CatalogueEntry[]
  loading: boolean
  error: string
  onRetry: () => void
  selected: string[]
  onChange: (ids: string[]) => void
  /** ids whose trade fits the package name or its sections */
  suggested: string[]
}) {
  const [trade, setTrade] = useState('')
  const [query, setQuery] = useState('')
  const trades = useMemo(() => [...new Set(entries.map((e) => (e.trade ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de')), [entries])
  const hint = useMemo(() => new Set(suggested), [suggested])
  const chosen = useMemo(() => new Set(selected), [selected])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries
      .filter((e) => (!trade || (e.trade ?? '').trim() === trade) && (!q || [e.name, e.trade, e.contact_name, e.email].some((s) => (s ?? '').toLowerCase().includes(q))))
      .sort((a, b) => Number(hint.has(b.id)) - Number(hint.has(a.id)) || a.name.localeCompare(b.name, 'de'))
  }, [entries, trade, query, hint])

  const toggle = (id: string) => onChange(chosen.has(id) ? selected.filter((x) => x !== id) : [...selected, id])
  const pickSuggested = () => onChange([...new Set([...selected, ...suggested])])
  const missing = selected.filter((id) => entries.find((e) => e.id === id && !e.email?.trim()))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1">
          <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400" />
          <input aria-label="Search subcontractors" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search subcontractors…" className={`${inputCls} h-9 pl-8`} />
        </div>
        <select aria-label="Filter by trade" value={trade} onChange={(e) => setTrade(e.target.value)} className={`${inputCls} h-9 w-auto min-w-36`}>
          <option value="">All trades</option>
          {trades.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {suggested.length > 0 && <Button size="sm" variant="soft" icon="auto_awesome" onClick={pickSuggested}>Select suggested ({suggested.length})</Button>}
      </div>

      {loading && !entries.length && <p className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-600">Loading the catalogue…</p>}
      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          <span>{error}</span>
          <Button size="sm" onClick={onRetry}>Try again</Button>
        </div>
      )}
      {!loading && !error && entries.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-600">
          No subcontractors yet. <Link to="/catalogues/subcontractors" className="font-semibold text-brand-700 underline">Add them in the catalogue</Link>, then come back.
        </p>
      )}
      {entries.length > 0 && shown.length === 0 && <p className="px-1 text-sm text-slate-600">No subcontractor matches this filter.</p>}

      <ul role="group" aria-label="Subcontractors" className="max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 bg-white">
        {shown.map((e) => {
          const on = chosen.has(e.id)
          const noMail = !e.email?.trim()
          return (
            <li key={e.id}>
              <label className={clsx('flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50', on && 'bg-brand-50/60')}>
                <input type="checkbox" className="checkbox" checked={on} onChange={() => toggle(e.id)} aria-label={e.name} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span className="truncate font-semibold text-slate-800">{e.name}</span>
                    {e.trade && <span className="rounded-md bg-slate-100 px-1.5 py-px text-[11px] text-slate-600">{e.trade}</span>}
                    {hint.has(e.id) && <span className="rounded-md bg-brand-50 px-1.5 py-px text-[11px] font-semibold text-brand-700">Fits this package</span>}
                  </span>
                  <span className="block truncate text-xs text-slate-600">{[e.contact_name, e.email].filter(Boolean).join(' · ') || 'No contact details'}</span>
                </span>
                {noMail && (
                  <span className="flex shrink-0 items-center gap-1 rounded-md bg-amber-50 px-1.5 py-px text-[11px] font-semibold text-amber-800" title="The draft will have no recipient address">
                    <Icon name="mail_off" size={13} />No email
                  </span>
                )}
              </label>
            </li>
          )
        })}
      </ul>
      {missing.length > 0 && (
        <p role="status" className="flex items-start gap-2 text-xs text-amber-800">
          <Icon name="warning" size={15} className="mt-px shrink-0" />
          {missing.length === 1 ? 'One selected subcontractor has' : `${missing.length} selected subcontractors have`} no email in the catalogue. Their draft opens without a recipient, so add the address in your mail client.
        </p>
      )}
    </div>
  )
}
