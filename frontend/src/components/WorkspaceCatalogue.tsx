import { useState } from 'react'
import { Button, Icon } from './ui'
import { MetaLink } from './Kit'
import type { Position } from '../lib/types'
import { money, parseNumber } from '../lib/format'
import { researchFilterOf, type CataloguePosition, type CatalogueReport, type ResearchFilter } from '../lib/workspace-catalogue'

const labels: Record<CataloguePosition['state'], string> = {
  matched: 'Catalogue match',
  activity: 'Recorded activity',
  needs_description: 'Needs a description',
  queued: 'Research queued',
  researching: 'Researching on the web',
  suggested: 'Web suggestion',
  no_evidence: 'No reliable web evidence',
  failed: 'Research failed',
  research_disabled: 'Web research disabled',
}

type ResearchView = ResearchFilter | null

/**
 * catalogue research for a list in two parts that share one `show` state: `line` is a single status line that sits in the
 * list hero (no band of its own), `list` is the positions behind the pressed count, shown under the hero.
 */
/** the cited note a web suggestion adds to the long description */
export const suggestionNote = (suggestion: NonNullable<CataloguePosition['suggestion']>) =>
  `${suggestion.name} — ${suggestion.description}\n${suggestion.source} ${suggestion.url}`
/** the long description with the note added, or null when it is already there */
export function withSuggestion(position: Position, result: CataloguePosition): string | null {
  if (!result.suggestion) return null
  const note = suggestionNote(result.suggestion)
  return position.long?.includes(note) ? null : [position.long, note].filter(Boolean).join('\n\n')
}

/** a unit price typed straight into the research list, for positions neither the catalogue nor the web could match */
function PriceInput({ position, onPrice }: { position: Position; onPrice: (id: string, price: number | null) => void }) {
  const shown = position.up == null ? '' : position.up.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const empty = draft.trim() === ''
    const value = empty ? null : parseNumber(draft)
    setDraft(null)
    if (!empty && (value === null || value < 0)) return
    if (value !== position.up) onPrice(position.id, value)
  }
  return (
    <label className="flex shrink-0 items-center gap-1.5 text-[13px] text-slate-600">
      <span className="max-sm:sr-only">EP</span>
      <input inputMode="decimal" aria-label={`Unit price for ${position.oz}${position.unit ? ` per ${position.unit}` : ''}`}
        value={draft ?? shown} placeholder="Price" onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur() } if (e.key === 'Escape') setDraft(null) }}
        className="num h-8 w-24 rounded-md bg-white px-2 text-right text-sm text-slate-900 ring-1 ring-slate-400 outline-none ring-inset focus:ring-2 focus:ring-brand-600" />
      <span className="w-10 truncate">{position.unit ? `€/${position.unit}` : '€'}</span>
    </label>
  )
}

export function CatalogueOverview({ report, error, retryFailed, positions, onOpen, part, show, setShow, onApplyAll, onPrice }: {
  /** adds several web suggestions to their long descriptions in one go */
  onApplyAll?: (changes: { id: string; long: string }[]) => void
  /** sets the unit price of a position that has no catalogue or web match */
  onPrice?: (id: string, price: number | null) => void
  report: CatalogueReport | null
  error: string
  retryFailed: () => Promise<void>
  positions: Position[]
  onOpen: (id: string) => void
  part: 'line' | 'list'
  show: ResearchView
  setShow: (v: ResearchView) => void
}) {
  const [unpicked, setUnpicked] = useState<Set<string>>(new Set())
  const rows = positions.flatMap((item) => {
    const result = report?.positions[item.id]
    return result ? [{ item, result }] : []
  })
  const pending = rows.filter(({ result }) => result.state === 'queued' || result.state === 'researching').length
  const failed = rows.some(({ result }) => result.state === 'failed')
  const totals: Record<ResearchFilter, number> = { matched: 0, suggested: 0, unresolved: 0 }
  for (const { result } of rows) {
    const filter = researchFilterOf(result.state)
    if (filter) totals[filter]++
  }
  const { matched, suggested, unresolved } = totals
  const visible = rows.filter(({ result }) => show && researchFilterOf(result.state) === show)

  const ready = report?.state === 'ready' && !pending && !error
  if (part === 'line') {
    const toggle = (v: Exclude<ResearchView, null>) => setShow(show === v ? null : v)
    const links = report?.state === 'ready' ? [
      (matched > 0 || show === 'matched') && <MetaLink key="m" pressed={show === 'matched'} onClick={() => toggle('matched')}><span className="num">{matched}</span> {matched === 1 ? 'match' : 'matches'}</MetaLink>,
      (suggested > 0 || show === 'suggested') && <MetaLink key="s" pressed={show === 'suggested'} onClick={() => toggle('suggested')}><span className="num">{suggested}</span> web {suggested === 1 ? 'suggestion' : 'suggestions'}</MetaLink>,
      (unresolved > 0 || show === 'unresolved') && <MetaLink key="u" pressed={show === 'unresolved'} onClick={() => toggle('unresolved')}><span className="num">{unresolved}</span> without a match</MetaLink>,
    ].filter(Boolean) : []
    const label = error || (report?.state === 'failed' ? 'Catalogue matching failed' :
      !report || report.state === 'queued' || report.state === 'unstarted' ? 'Matching positions to the catalogue…' :
        pending ? `Catalogue research: ${pending} positions in progress` :
          report.web_research === false ? 'Catalogue matching complete' : 'Catalogue research')
    // once results are in, the row label names the group and the counts speak for themselves
    const quiet = ready && links.length > 0
    return (
      <span role="group" aria-label="Catalogue position filters" className="flex flex-wrap items-center gap-x-1 gap-y-1">
        <span className="inline-flex w-[5.5rem] shrink-0 items-center gap-1.5 text-[13px] font-medium text-slate-500">
          <Icon name="inventory_2" size={16} />Catalogue
        </span>
        <span role="status" className={quiet ? 'sr-only' : 'px-2'}>{label}</span>
        {links}
        {ready && !links.length && <span className="px-2">Nothing found</span>}
        {(error || report?.state === 'failed' || failed) &&
          <Button size="sm" onClick={() => void retryFailed()}>Retry</Button>}
      </span>
    )
  }

  const applicable = show === 'suggested' ? visible.flatMap(({ item, result }) => {
    const long = withSuggestion(item, result)
    return long ? [{ id: item.id, long }] : []
  }) : []
  const picked = applicable.filter(({ id }) => !unpicked.has(id))
  const unpricedLeft = show === 'unresolved' ? visible.filter(({ item }) => item.up == null).length : 0
  const pricedTotal = show === 'unresolved' ? visible.reduce((sum, { item }) => sum + (item.up ?? 0) * item.qty, 0) : 0
  return (
    <section id="research-list" aria-label="Catalogue research" className="text-sm">
      {show === 'suggested' && onApplyAll && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-slate-600">{applicable.length
            ? 'Check each source against the tender text. Ticked suggestions are added to the long descriptions; Undo puts them back.'
            : 'No unapplied web suggestions in the shown positions.'}</p>
          {applicable.length > 0 && (
            <Button size="sm" variant="primary" icon="done_all" disabled={!picked.length} onClick={() => { onApplyAll(picked); setUnpicked(new Set()) }}>
              {picked.length === applicable.length ? `Apply all ${applicable.length}` : `Apply ${picked.length} of ${applicable.length}`}
            </Button>
          )}
        </div>
      )}
      {show === 'unresolved' && onPrice && visible.length > 0 && (
        <p className="mb-2 text-slate-600">
          These positions have no catalogue match or web suggestion. You can enter your own unit price here.
          {' '}<span className="num">{unpricedLeft}</span> still without a price{pricedTotal > 0 && <>, <span className="num font-medium text-slate-800">{money(pricedTotal)}</span> priced here</>}.
        </p>
      )}
      {show && (
        <ul className="max-h-60 divide-y divide-slate-200 overflow-y-auto border-y border-slate-200">
          {visible.map(({ item, result }) => (
            <li key={item.id} className="flex items-center gap-1">
              {show === 'suggested' && onApplyAll && (withSuggestion(item, result)
                ? <input type="checkbox" aria-label={`Apply the suggestion for ${item.oz}`} checked={!unpicked.has(item.id)} className="ml-2 size-4 shrink-0 accent-brand-700"
                  onChange={() => setUnpicked((prev) => { const next = new Set(prev); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next })} />
                : <span title="Already applied" className="ml-2 inline-flex shrink-0"><Icon name="check" size={16} className="text-slate-500" /></span>)}
              <button type="button" onClick={() => onOpen(item.id)} className="flex min-h-10 min-w-0 flex-1 flex-wrap items-center justify-between gap-2 rounded-md px-2 py-2 text-left hover:bg-slate-100">
                <span className="text-slate-800"><span className="mr-2 font-mono text-[13px] text-slate-600">{item.oz}</span>{' '}{item.short || 'Position without a description'}</span>
                <span className="font-medium text-slate-900">{result.product?.name || result.suggestion?.name || labels[result.state]}</span>
              </button>
              {(show === 'unresolved' || show === 'suggested') && onPrice && <PriceInput position={item} onPrice={onPrice} />}
            </li>
          ))}
          {!visible.length && <li className="px-2 py-2 text-slate-600">No catalogue results match the current filters.</li>}
        </ul>
      )}
    </section>
  )
}

export function CatalogueDetails({ result, position, onApply }: {
  result: CataloguePosition
  position: Position
  onApply: (description: string) => void
}) {
  const suggestion = result.suggestion
  const note = suggestion ? suggestionNote(suggestion) : ''
  const applied = Boolean(note && position.long?.includes(note))
  return (
    <section aria-labelledby="drawer-catalogue-h" className="space-y-1.5 text-sm leading-relaxed text-slate-700">
      <h3 id="drawer-catalogue-h" className="text-[15px] font-semibold text-slate-900">Catalogue research</h3>
      <p>
        {result.state === 'no_evidence' ? (result.model_review ? 'Catalogue match unresolved.' : 'No matching product found online.') : <>
          <span className="font-medium text-slate-800">{
            result.model_review && result.state === 'queued' ? 'Catalogue review queued' :
              result.model_review && result.state === 'researching' ? 'Checking catalogue evidence' : labels[result.state]
          }.</span>
          {result.state === 'needs_description' && ' The imported row has no description to search for.'}
        </>}
      </p>
      {result.recovered?.source && <p>Missing description recovered from the companion offer PDF.</p>}
      {result.product && <p><strong>{result.product.name}</strong> · {result.product.category}</p>}
      {suggestion && <>
        <p><strong>{suggestion.name}</strong> · {suggestion.description}</p>
        {suggestion.price && <p>Retail price: {money(Number(suggestion.price))} per product package. This is not the tender unit price.</p>}
        <div className="flex flex-wrap gap-x-2">
          <a href={suggestion.url} target="_blank" rel="noreferrer" className="font-medium text-brand-700 underline">View product on {suggestion.source}</a>
        </div>
        <p>Check the source against the tender specifications before applying.</p>
        <Button size="sm" disabled={applied} onClick={() => onApply([position.long, note].filter(Boolean).join('\n\n'))}>
          {applied ? 'Suggestion applied' : 'Apply to long description'}
        </Button>
      </>}
    </section>
  )
}
