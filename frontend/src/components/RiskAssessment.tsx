import { clsx } from 'clsx'
import { Icon, Menu, type MenuItem } from './ui'
import { ToolButton } from './Kit'
import { money } from '../lib/format'
import { dependencyReviewLines, findingCategory, REASONS, SEVERITIES, type ChangeOrderSignal, type Decision, type Finding, type ReviewItem, type Severity } from '../lib/risk-assessment'

/**
 * severity colours for the risk UI, built on the themed status tokens so they hold in dark mode.
 * Rows carry a filled flag chip (tint + icon + word, like every status chip); inside a finding the left bar is the only
 * colour block, so the severity is just an inline flag and word.
 * a flagged row carries a 3px severity bar on its leading edge and a light tint of the same colour across the row.
 * `flag` matches the bar so a flag icon reads as the same signal; `ink` stays darker for text contrast.
 */
export const RISK_UI: Record<Severity, { label: string; plural: string; icon: string; chip: string; ink: string; flag: string; tint: string; row: string; bar: string }> = {
  error: { label: 'Critical', plural: 'Critical warnings', icon: 'flag', chip: 'bg-rose-100 text-rose-800', ink: 'text-rose-800', flag: 'text-rose-600', tint: 'bg-rose-50 hover:bg-rose-100', row: '[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-rose-600)]', bar: 'border-rose-600' },
  warning: { label: 'Warning', plural: 'Warnings', icon: 'flag', chip: 'bg-amber-100 text-amber-900', ink: 'text-amber-900', flag: 'text-amber-500', tint: 'bg-amber-50 hover:bg-amber-100', row: '[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-amber-500)]', bar: 'border-amber-500' },
  info: { label: 'Note', plural: 'Notes', icon: 'flag', chip: 'bg-slate-200 text-slate-800', ink: 'text-slate-700', flag: 'text-slate-400', tint: 'bg-slate-50 hover:bg-slate-100', row: '[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-slate-400)]', bar: 'border-slate-400' },
}

/** change orders are money, not a defect, so they get the one cool hue and never read as another severity */
export const CHANGE_ORDER_UI = { label: 'Change order', icon: 'flag', chip: 'bg-sky-100 text-sky-900', flag: 'text-sky-600', tint: 'bg-sky-50 hover:bg-sky-100', row: '[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-sky-600)]', bar: 'border-sky-600' }

/** a row's tone: its worst finding, or the change-order hue when it only carries change-order signals */
export type RowTone = Severity | 'change'
export const rowUi = (tone: RowTone) => (tone === 'change' ? CHANGE_ORDER_UI : RISK_UI[tone])

/** the checker names its scopes in its own terms ("in Entire BoQ"); say them the way an estimator would */
const plainFindingText = (text: string) => text.replace(/\bin (the )?Entire BoQ\b/gi, 'anywhere in this list').replace(/\bEntire BoQ\b/g, 'the whole list')

export function FindingBadge({ severity, children }: { severity: RowTone; children?: React.ReactNode }) {
  const style = rowUi(severity)
  return (
    <span className={clsx('inline-flex h-6 max-w-full items-center gap-1 rounded-md px-1.5 text-[13px] font-semibold', style.chip)}>
      <Icon name={style.icon} size={15} fill className="shrink-0" />
      {children ?? (severity === 'error' ? 'Blocking Error' : style.label)}
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

/** one finding: a severity bar on the leading edge, the badge and title, then the explanation */
export function FindingText({ finding, reviewed, decision, changed, hideRationale, details }: {
  finding: Finding; reviewed?: boolean; decision?: Decision; changed?: boolean; hideRationale?: boolean; details?: boolean
}) {
  const decided = reviewed || !!decision
  const muted = decided || changed
  const isBlocking = finding.severity === 'error' && !decided
  const [reviewTitle, ...reviewDetails] = dependencyReviewLines(finding)
  return (
    <div className={clsx('min-w-0 border-l-[3px] pl-3', muted ? 'border-slate-300' : RISK_UI[finding.severity].bar)}>
      <div className="flex flex-wrap items-center gap-2">
        {decision ? (
          <span className={clsx('inline-flex items-center gap-1 text-[13px] font-semibold text-slate-600')}>
            <Icon name={decision.status === 'accepted' ? 'check' : 'block'} size={15} className="shrink-0" />
            {decision.status === 'accepted' ? 'Accepted' : `Dismissed${decision.reason ? ` · ${REASONS[decision.reason]}` : ''}`}
          </span>
        ) : (
          <span className={clsx('inline-flex items-center gap-1 text-[13px] font-semibold', muted ? 'text-slate-600' : RISK_UI[finding.severity].ink)}>
            <Icon name={reviewed ? 'check' : changed ? 'edit' : RISK_UI[finding.severity].icon} size={15} fill={!muted} className="shrink-0" />
            {reviewed ? 'Reviewed' : changed ? 'Changed since upload' : isBlocking ? 'Blocking Error' : RISK_UI[finding.severity].label}
          </span>
        )}
        {finding.origin === 'llm' && (
          <span title={finding.model ?? undefined} className="inline-flex h-6 items-center gap-1 rounded-md bg-brand-50 px-1.5 text-[13px] font-semibold text-brand-700 ring-1 ring-brand-300 ring-inset">
            <Icon name="auto_awesome" size={15} className="shrink-0" />AI check{details && finding.model ? ` · ${finding.model}` : ''}
          </span>
        )}
        <h4 className={clsx('text-[15px] font-semibold', muted ? 'text-slate-700' : 'text-slate-900')}>{finding.title}</h4>
      </div>
      {changed && !decided && <p className="mt-1 text-sm leading-relaxed text-pretty text-slate-700">You edited this value after the upload check. The note below describes the uploaded version.</p>}
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
    <div className={clsx('min-w-0 border-l-[3px] pl-3', decision ? 'border-slate-300' : CHANGE_ORDER_UI.bar)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-slate-600">
          {decision?.status === 'accepted' ? 'Accepted' : decision ? `Dismissed${decision.reason ? ` · ${REASONS[decision.reason]}` : ''}` : 'Change-order signal'}
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
  const severities = new Map<Severity, number>()
  const types = new Map<string, { title: string; count: number }>()
  const categories = new Map<string, number>()
  let flagged = 0
  let reviewedRows = 0
  let changeOrders = 0
  for (const items of rows) {
    const open = items.filter((item) => !reviewed.has(item.id))
    const findings = items.filter((item) => 'severity' in item)
    const openFindings = open.filter((item) => 'severity' in item)
    if (open.length) flagged++
    if (open.length < items.length) reviewedRows++
    if (open.some((item) => !('severity' in item))) changeOrders++
    for (const severity of new Set(openFindings.map((finding) => finding.severity))) {
      severities.set(severity, (severities.get(severity) ?? 0) + 1)
    }
    for (const category of new Set(openFindings.flatMap((finding) => finding.category ? [finding.category] : []))) {
      categories.set(category, (categories.get(category) ?? 0) + 1)
    }
    const openTypes = new Set(openFindings.map((finding) => finding.rule_id))
    for (const [id, title] of new Map(findings.map((finding) => [finding.rule_id, finding.title]))) {
      types.set(id, { title, count: (types.get(id)?.count ?? 0) + Number(openTypes.has(id)) })
    }
  }
  if (!rows.length && value === 'all') return null

  const option = (key: string, label: string, count?: number, icon?: string): MenuItem => ({
    label, icon, checked: value === key, hint: count === undefined ? undefined : String(count), onSelect: () => onChange(key),
  })
  const sortedTypes = [...types].sort(([, a], [, b]) => a.title.localeCompare(b.title))
  const items: (MenuItem | 'sep')[] = [
    option('all', 'All positions'),
    option('flagged', 'Flagged positions', flagged),
    option('reviewed', 'Reviewed positions', reviewedRows),
    'sep',
    ...SEVERITIES.filter((severity) => severities.get(severity)).map((severity) => option(severity, RISK_UI[severity].plural, severities.get(severity), RISK_UI[severity].icon)),
    ...(changeOrders > 0 || value === 'change-orders' ? [option('change-orders', 'Change-order signals', changeOrders)] : []),
    ...(categories.size ? ['sep' as const, ...[...categories].sort(([a], [b]) => a.localeCompare(b)).map(([id, count]) =>
      option(`category:${id}`, findingCategory(id), count))] : []),
    ...(sortedTypes.length ? ['sep' as const, ...sortedTypes.map(([id, type]) => option(`rule:${id}`, type.title, type.count))] : []),
  ]
  const current = value === 'all' ? null
    : value === 'flagged' ? 'Flagged'
    : value === 'reviewed' ? 'Reviewed'
    : value === 'change-orders' ? 'Change-order signals'
    : value.startsWith('category:') ? findingCategory(value.slice(9))
    : value.startsWith('rule:') ? types.get(value.slice(5))?.title ?? 'Finding'
    : RISK_UI[value as Severity]?.plural ?? null

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
