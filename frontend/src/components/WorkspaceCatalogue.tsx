import { Fragment } from 'react'
import { Button, Icon } from './ui'
import { MetaLink } from './Kit'
import type { Position } from '../lib/types'
import type { CataloguePosition, CatalogueReport } from '../lib/workspace-catalogue'

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

export type ResearchView = 'suggested' | 'matched' | 'unresolved' | null

/**
 * catalogue research for a list in two parts that share one `show` state: `line` is a single status line that sits in the
 * list hero (no band of its own), `list` is the positions behind the pressed count, shown under the hero.
 */
export function CatalogueOverview({ report, error, retryFailed, positions, onOpen, part, show, setShow, hideMatched }: {
  /** matches that already became pending prices: the pricing status says it, so the research line doesn't repeat it */
  hideMatched?: { has: (id: string) => boolean }
  report: CatalogueReport | null
  error: string
  retryFailed: () => Promise<void>
  positions: Position[]
  onOpen: (id: string) => void
  part: 'line' | 'list'
  show: ResearchView
  setShow: (v: ResearchView) => void
}) {
  const rows = positions.flatMap((item) => {
    const result = report?.positions[item.id]
    return result ? [{ item, result }] : []
  })
  const count = (state: CataloguePosition['state']) => rows.filter(({ item, result }) => result.state === state && !(state === 'matched' && hideMatched?.has(item.id))).length
  const pending = count('queued') + count('researching')
  const unresolved = count('failed') + count('no_evidence') + count('needs_description') + count('research_disabled')
  const visible = rows.filter(({ result }) =>
    show === 'unresolved' ? ['failed', 'no_evidence', 'needs_description', 'research_disabled'].includes(result.state) : result.state === show,
  )

  const ready = report?.state === 'ready' && !pending && !error
  if (part === 'line') {
    const toggle = (v: Exclude<ResearchView, null>) => setShow(show === v ? null : v)
    const links = report?.state === 'ready' ? [
      count('matched') > 0 && <MetaLink key="m" pressed={show === 'matched'} onClick={() => toggle('matched')}><span className="num">{count('matched')}</span> {count('matched') === 1 ? 'match' : 'matches'}</MetaLink>,
      count('suggested') > 0 && <MetaLink key="s" pressed={show === 'suggested'} onClick={() => toggle('suggested')}><span className="num">{count('suggested')}</span> web {count('suggested') === 1 ? 'suggestion' : 'suggestions'}</MetaLink>,
      unresolved > 0 && <MetaLink key="u" pressed={show === 'unresolved'} onClick={() => toggle('unresolved')}><span className="num">{unresolved}</span> without a match</MetaLink>,
    ].filter(Boolean) : []
    const label = error || (report?.state === 'failed' ? 'Catalogue matching failed' :
      !report || report.state === 'queued' || report.state === 'unstarted' ? 'Matching positions to the catalogue…' :
        pending ? `Catalogue research: ${pending} positions in progress` :
          report.web_research === false ? 'Catalogue matching complete' : 'Catalogue research')
    // once results are in, the icon names the group and the counts speak for themselves: the status row stays on one line
    const quiet = ready && links.length > 0
    return (
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span title={quiet ? 'Catalogue research' : undefined} className="inline-flex"><Icon name="inventory_2" size={16} className="text-slate-500" /></span>
        <span role="status" className={quiet ? 'sr-only' : undefined}>{label}</span>
        {links.map((l, i) => <Fragment key={i}>{(i > 0 || !quiet) && <span aria-hidden>·</span>}{l}</Fragment>)}
        {ready && !links.length && !rows.some(({ item }) => hideMatched?.has(item.id)) && <span>· nothing found</span>}
        {(error || report?.state === 'failed' || count('failed') > 0) &&
          <Button size="sm" onClick={() => void retryFailed()}>Retry</Button>}
      </span>
    )
  }

  return (
    <section id="research-list" aria-label="Catalogue research" className="text-sm">
      {show && (
        <ul className="max-h-60 divide-y divide-slate-200 overflow-y-auto border-y border-slate-200">
          {visible.map(({ item, result }) => (
            <li key={item.id}>
              <button type="button" onClick={() => onOpen(item.id)} className="flex min-h-10 w-full flex-wrap items-center justify-between gap-2 rounded-md px-2 py-2 text-left hover:bg-slate-100">
                <span className="text-slate-800"><span className="mr-2 font-mono text-[13px] text-slate-600">{item.oz}</span>{' '}{item.short || 'Position without a description'}</span>
                <span className="font-medium text-slate-900">{result.product?.name || result.suggestion?.name || labels[result.state]}</span>
              </button>
            </li>
          ))}
          {!visible.length && <li className="px-2 py-2 text-slate-600">There are no positions in this view yet.</li>}
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
  const note = suggestion ? `${suggestion.name} — ${suggestion.description}\nWikipedia (CC BY-SA 4.0) ${suggestion.url}` : ''
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
        <div className="flex flex-wrap gap-x-2">
          <a href={suggestion.url} target="_blank" rel="noreferrer" className="font-medium text-brand-700 underline">Source on {suggestion.source}</a>
          <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer" className="text-slate-600 underline">CC BY-SA 4.0</a>
        </div>
        <p>Check the source against the tender specifications before applying.</p>
        <Button size="sm" disabled={applied} onClick={() => onApply([position.long, note].filter(Boolean).join('\n\n'))}>
          {applied ? 'Suggestion applied' : 'Apply to long description'}
        </Button>
      </>}
    </section>
  )
}
