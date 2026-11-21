import { useState } from 'react'
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
}

export function CatalogueOverview({ report, error, retryFailed, positions, onOpen }: {
  report: CatalogueReport | null
  error: string
  retryFailed: () => Promise<void>
  positions: Position[]
  onOpen: (id: string) => void
}) {
  const [show, setShow] = useState<'suggested' | 'matched' | 'unresolved' | null>(null)
  const rows = positions.flatMap((item) => {
    const result = report?.positions[item.id]
    return result ? [{ item, result }] : []
  })
  const count = (state: CataloguePosition['state']) => rows.filter(({ result }) => result.state === state).length
  const pending = count('queued') + count('researching')
  const unresolved = count('failed') + count('no_evidence') + count('needs_description')
  const visible = rows.filter(({ result }) =>
    show === 'unresolved' ? ['failed', 'no_evidence', 'needs_description'].includes(result.state) : result.state === show,
  )

  return (
    <section aria-label="Catalogue and web research" className="text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="flex items-center gap-1.5 font-semibold text-slate-900">
          <Icon name="inventory_2" size={18} className="text-slate-600" /> Catalogue research
        </h2>
        <span role="status" className="text-slate-600">
          {error || (report?.state === 'failed' ? 'Catalogue matching failed.' :
            !report || report.state === 'queued' || report.state === 'unstarted' ? 'Matching imported positions…' :
              pending ? `${pending} positions queued or researching` : 'Research complete')}
        </span>
        {report?.state === 'ready' && (
          <>
            {count('matched') > 0 ? (
              <MetaLink pressed={show === 'matched'} onClick={() => setShow(show === 'matched' ? null : 'matched')}>
                <span className="num">{count('matched')}</span> catalogue {count('matched') === 1 ? 'match' : 'matches'}
              </MetaLink>
            ) : <span className="text-slate-600">No catalogue matches</span>}
            {count('suggested') > 0 ? (
              <MetaLink pressed={show === 'suggested'} onClick={() => setShow(show === 'suggested' ? null : 'suggested')}>
                <span className="num">{count('suggested')}</span> web {count('suggested') === 1 ? 'suggestion' : 'suggestions'}
              </MetaLink>
            ) : <span className="text-slate-600">No web suggestions</span>}
            {unresolved > 0 && (
              <MetaLink pressed={show === 'unresolved'} onClick={() => setShow(show === 'unresolved' ? null : 'unresolved')}>
                <span className="num">{unresolved}</span> unresolved
              </MetaLink>
            )}
          </>
        )}
        {(error || report?.state === 'failed' || count('failed') > 0) &&
          <Button size="sm" onClick={() => void retryFailed()}>Retry catalogue research</Button>}
      </div>
      {show && (
        <ul className="mt-3 max-h-60 divide-y divide-slate-200 overflow-y-auto border-y border-slate-200">
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
      <p className="font-medium text-slate-800">{labels[result.state]}</p>
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
      {result.state === 'needs_description' && <p>The imported row has no description to search for.</p>}
      {result.state === 'no_evidence' && <p>The web search did not find a source with a relevant title.</p>}
    </section>
  )
}
