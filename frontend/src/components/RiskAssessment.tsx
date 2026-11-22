import { clsx } from 'clsx'
import { Icon, Menu, type MenuItem } from './ui'
import { ToolButton } from './Kit'
import { money } from '../lib/format'
import { dependencyReviewLines, REASONS, WARNING_TYPES, WARNING_TYPE_ORDER, warningColor, warningGroup, warningStyle, warningTitle, warningType, type ChangeOrderSignal, type Decision, type Finding, type ReviewItem, type WarningType } from '../lib/risk-assessment'

/** the checker names its scopes in its own terms ("in Entire BoQ"); say them the way an estimator would */
const plainFindingText = (text: string) => text.replace(/\bin (the )?Entire BoQ\b/gi, 'anywhere in this list').replace(/\bEntire BoQ\b/g, 'the whole list')

export function WarningFlag({ type, size = 15 }: { type?: WarningType; size?: number }) {
  return <span aria-hidden="true" className="inline-flex shrink-0" style={{ color: warningColor(type) }}>
    <Icon name="flag" size={size} fill />
  </span>
}

export function WarningBadge({ type, children }: { type?: WarningType; children: React.ReactNode }) {
  return (
    <span className="warning-badge inline-flex h-6 max-w-full items-center gap-1 rounded-md px-1.5 text-[13px] font-semibold text-slate-800"
      style={warningStyle(type)}>
      <WarningFlag type={type} />
      {children}
    </span>
  )
}


/** what layer 3 or a DIN rule found, shown under the message in the drawer */
function FindingEvidence({ finding }: { finding: Finding }) {
  const evidence = finding.evidence
  const din = evidence?.din
  const standard = evidence?.standard ?? (din ? 'DIN 1045-2' : undefined)
  const excerpt = evidence?.excerpt ?? evidence?.clause
  const extracted = Object.entries(evidence?.extracted ?? {})
  if (!standard && !excerpt && !extracted.length) return null
  const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : Array.isArray(v) ? v.join(', ') || '—' : String(v))
  return (
    <div className="mt-2 space-y-2 text-[13px]">
      {standard && (
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-slate-700">
          <span className="font-semibold text-slate-900">{standard}</span>
          {din?.grade && <span>Grade <span className="num font-medium">{din.grade}</span></span>}
          {!!din?.exposure?.length && <span>Exposure <span className="num font-medium">{din.exposure.join(', ')}</span></span>}
          {din?.required_min && <span>Minimum <span className="num font-medium">{din.required_min}</span></span>}
        </p>
      )}
      {excerpt && <p className="text-slate-700"><strong>Source excerpt</strong> “{excerpt}”</p>}
      {extracted.length > 0 && (
        <table className="w-full max-w-sm text-left">
          <caption className="mb-1 text-left font-semibold text-slate-900">Read from the text</caption>
          <tbody>
            {extracted.map(([key, value]) => (
              <tr key={key} className="border-t border-slate-200">
                <th scope="row" className="py-1 pr-3 font-medium text-slate-600">{key.replace(/_/g, ' ')}</th>
                <td className={clsx('num py-1', value == null ? 'text-amber-900' : 'text-slate-900')}>{show(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** One warning with its type, evidence and review status. */
export function FindingText({ finding, reviewed, decision, changed, hideRationale, details }: {
  finding: Finding; reviewed?: boolean; decision?: Decision; changed?: boolean; hideRationale?: boolean; details?: boolean
}) {
  const decided = reviewed || !!decision
  const muted = decided || changed
  const type = warningType(finding)
  const [reviewTitle, ...reviewDetails] = dependencyReviewLines(finding)
  return (
    <div className="min-w-0 border-l-[3px] pl-3" style={{ borderColor: muted ? 'var(--color-slate-300)' : warningColor(type) }}>
      <div className="flex flex-wrap items-center gap-2">
        {decision ? (
          <span className={clsx('inline-flex items-center gap-1 text-[13px] font-semibold text-slate-600')}>
            <Icon name={decision.status === 'accepted' ? 'check' : 'block'} size={15} className="shrink-0" />
            {decision.status === 'accepted' ? 'Accepted' : `Dismissed${decision.reason ? ` · ${REASONS[decision.reason]}` : ''}`}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-slate-700">
            {muted ? <Icon name={reviewed ? 'check' : 'edit'} size={15} /> : <WarningFlag type={type} />}
            {reviewed ? 'Reviewed' : changed ? 'Changed since upload' : WARNING_TYPES[type].label}
          </span>
        )}
        {finding.origin === 'llm' && (
          <span title={finding.model ?? undefined} className="inline-flex h-6 items-center gap-1 rounded-md bg-brand-50 px-1.5 text-[13px] font-semibold text-brand-700 ring-1 ring-brand-300 ring-inset">
            <Icon name="auto_awesome" size={15} className="shrink-0" />AI check{details && finding.model ? ` · ${finding.model}` : ''}
          </span>
        )}
        <h4 className={clsx('text-[15px] font-semibold', muted ? 'text-slate-700' : 'text-slate-900')}>{warningTitle(finding)}</h4>
      </div>
      {changed && !decided && <p className="mt-1 text-sm leading-relaxed text-pretty text-slate-700">You edited this value after the upload check. This warning describes the uploaded version.</p>}
      <p className={clsx('mt-1 text-sm leading-relaxed text-pretty', muted ? 'text-slate-600' : 'text-slate-700')}>{plainFindingText(finding.message)}</p>
      {reviewTitle && <div className="mt-1 space-y-0.5 text-sm text-slate-700">
        <p className="font-semibold">{reviewTitle}</p>
        {reviewDetails.map((detail, index) => <p key={index}>{detail}</p>)}
      </div>}
      {!hideRationale && finding.suggested_fix?.rationale && (
        <p className="mt-1 text-sm leading-relaxed text-pretty text-slate-600">{details && <span className="font-semibold text-slate-700">Suggested fix: </span>}{finding.suggested_fix.rationale}</p>
      )}
      {details && <FindingEvidence finding={finding} />}
      {details && finding.evidence?.amount_at_stake != null && Number.isFinite(Number(finding.evidence.amount_at_stake)) && (
        <p className="mt-1 text-sm text-slate-600">Money at stake <strong>{money(Number(finding.evidence.amount_at_stake))}</strong></p>
      )}
      {decision?.note && <p className="mt-1 text-sm text-slate-600">Note: {decision.note}</p>}
    </div>
  )
}

export function ChangeOrderText({ signal, decision }: { signal: ChangeOrderSignal; decision?: Decision }) {
  return (
    <div className="min-w-0 border-l-[3px] pl-3" style={{ borderColor: decision ? 'var(--color-slate-300)' : warningColor('change') }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-slate-700">
          {!decision && <WarningFlag type="change" />}
          {decision?.status === 'accepted' ? 'Accepted' : decision ? `Dismissed${decision.reason ? ` · ${REASONS[decision.reason]}` : ''}` : WARNING_TYPES.change.label}
        </span>
        <h4 className="text-[15px] font-semibold text-slate-900">{signal.title}</h4>
      </div>
      <p className="mt-1 text-sm leading-relaxed text-slate-700">{signal.message}</p>
      {decision?.note && <p className="mt-1 text-sm text-slate-600">Note: {decision.note}</p>}
    </div>
  )
}

export function FindingFilter({ rows, reviewed, value, onChange }: {
  rows: ReviewItem[][]
  reviewed: Set<string>
  value: string
  onChange: (value: string) => void
}) {
  const types = new Map<WarningType, number>()
  const groups = new Map<string, { title: string; count: number }>()
  let flagged = 0
  let reviewedRows = 0
  for (const items of rows) {
    const open = items.filter((item) => !reviewed.has(item.id))
    if (open.length) flagged++
    if (open.length < items.length) reviewedRows++
    for (const type of new Set(open.map(warningType))) {
      types.set(type, (types.get(type) ?? 0) + 1)
    }
    const openGroups = new Set(open.map(warningGroup))
    for (const [key, title] of new Map(items.map((item) => [warningGroup(item), warningTitle(item)]))) {
      groups.set(key, { title, count: (groups.get(key)?.count ?? 0) + Number(openGroups.has(key)) })
    }
  }
  if (!rows.length && value === 'all') return null

  const option = (key: string, label: string, count?: number, icon?: string): MenuItem => ({
    label, icon, checked: value === key, hint: count === undefined ? undefined : String(count), onSelect: () => onChange(key),
  })
  const sortedGroups = [...groups].sort(([, a], [, b]) => a.title.localeCompare(b.title))
  const items: (MenuItem | 'sep')[] = [
    option('all', 'All positions'),
    option('flagged', 'Flagged positions', flagged),
    option('reviewed', 'Reviewed positions', reviewedRows),
    ...(types.size ? ['sep' as const, ...WARNING_TYPE_ORDER.filter((type) => types.has(type)).map((type) =>
      option(`type:${type}`, WARNING_TYPES[type].label, types.get(type), 'flag'))] : []),
    ...(sortedGroups.length ? ['sep' as const, ...sortedGroups.map(([key, group]) => option(key, group.title, group.count))] : []),
  ]
  const current = value === 'all' ? null
    : value === 'flagged' ? 'Flagged'
    : value === 'reviewed' ? 'Reviewed'
    : value.startsWith('type:') ? WARNING_TYPES[value.slice(5) as WarningType]?.label ?? 'Warnings'
    : groups.get(value)?.title ?? 'Warnings'

  return (
    <Menu
      label="Filter positions by upload check"
      width="w-72 max-h-[min(26rem,60dvh)] overflow-y-auto"
      items={items}
      trigger={(p) => (
        <ToolButton {...p} icon="flag" active={!!current}
          aria-label={`Upload check filter: ${current ?? 'all positions'}${flagged ? `, ${flagged} flagged ${flagged === 1 ? 'position' : 'positions'}` : ''}`}>
          <span className="max-w-[16ch] truncate">{current ?? 'Upload check'}</span>
          {/* a plain count like every other filter; the flag and the row rules carry the colour */}
          {!current && flagged > 0 && <span className="num text-slate-600">{flagged}</span>}
        </ToolButton>
      )}
    />
  )
}
