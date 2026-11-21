import { clsx } from 'clsx'
import { memo, useMemo, useState } from 'react'
import { Button, Icon } from '../ui'
import { FindingBadge, RISK_UI } from '../RiskAssessment'
import { DecisionControls, DismissMenu } from './DecisionControls'
import { int, money, plural } from '../../lib/format'
import { rescore, type Decision, type Decisions, type Finding, type Report, type Risk, type RiskLevel } from '../../lib/risk-assessment'

const LEVEL: Record<RiskLevel, { label: string; text: string; bar: string }> = {
  low: { label: 'Low', text: 'text-slate-800', bar: 'bg-slate-400' },
  medium: { label: 'Medium', text: 'text-amber-900', bar: 'bg-amber-500' },
  high: { label: 'High', text: 'text-orange-700', bar: 'bg-orange-500' },
  critical: { label: 'Critical', text: 'text-rose-700', bar: 'bg-rose-600' },
}
const CATEGORY: Record<string, string> = { din: 'DIN 1045-2', dependency: 'Dependencies', text: 'Text', unit: 'Units', scope: 'Scope', quantity: 'Quantities', price: 'Prices' }
const PAGE = 25

type Decide = (ids: string[], decision: Decision | null) => void

function Tile({ label, children, sub }: { label: string; children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg bg-slate-50 px-4 py-3">
      <dt className="text-[13px] font-medium text-slate-600">{label}</dt>
      <dd className="num mt-0.5 text-xl font-semibold text-slate-900">{children}</dd>
      {sub && <dd className="text-[13px] text-slate-600">{sub}</dd>}
    </div>
  )
}

function Bars({ title, rows }: { title: string; rows: { key: string; label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <section className="min-w-0">
      <h3 className="text-[15px] font-semibold text-slate-900">{title}</h3>
      {rows.length ? (
        <ul className="mt-2 space-y-2">
          {rows.map((r) => (
            <li key={r.key} className="grid grid-cols-[minmax(0,9rem)_1fr_2.5rem] items-center gap-2 text-sm">
              <span className="truncate text-slate-700" title={r.label}>{r.label}</span>
              <span className="h-2 rounded-full bg-slate-100"><span className="block h-2 rounded-full bg-brand-600" style={{ width: `${(100 * r.value) / max}%` }} /></span>
              <span className="num text-right text-slate-900">{int(r.value)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="mt-2 text-sm text-slate-600">Nothing open.</p>}
    </section>
  )
}

/** the risk review on top of a list: live score, top risks, distribution, change-order signals, bulk decisions */
export const RiskSummary = memo(function RiskSummary({ report, risk, decisions, codes, onDecide, onOpen, onExcel, onPrint }: {
  report: Report
  risk: Risk
  decisions: Decisions
  codes: Map<string, string>
  onDecide: Decide
  onOpen: (lineId: string) => void
  onExcel: () => void
  onPrint: () => void
}) {
  const live = rescore(risk, decisions)
  const findings = report.findings
  const open = findings.filter((f) => !decisions[f.id])
  const signals = risk.change_order_signals
  const openSignals = signals.filter((s) => !decisions[s.id])
  const items = findings.length + signals.length
  const reviewed = items - open.length - openSignals.length
  const at = (id: string) => (decisions[id] ? 0 : risk.points[id] ?? 0)

  const top = risk.top_risks
    .map((t) => ({ ...t, live: t.item_ids.reduce((sum, id) => sum + at(id), 0) }))
    .filter((t) => t.live > 0)
    .sort((a, b) => b.live - a.live)
    .slice(0, 10)
  const byCategory = new Map<string, number>()
  for (const f of open) if (f.category) byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + at(f.id))
  const byRule = useMemo(() => {
    const out = new Map<string, { title: string; ids: string[] }>()
    for (const f of findings) {
      if (decisions[f.id]) continue
      const rule = out.get(f.rule_id) ?? { title: f.title, ids: [] }
      rule.ids.push(f.id)
      out.set(f.rule_id, rule)
    }
    return [...out].filter(([, r]) => r.ids.length > 1).sort((a, b) => b[1].ids.length - a[1].ids.length)
  }, [findings, decisions])

  const [page, setPage] = useState(0)
  const pages = Math.max(1, Math.ceil(findings.length / PAGE))
  const shown = findings.slice(page * PAGE, page * PAGE + PAGE)
  const code = (f: Finding) => f.target.line_code ?? (f.target.line_id ? codes.get(f.target.line_id) : null) ?? f.target.section_id ?? 'List'
  const noLayer3 = report.layers_run && !report.layers_run.includes(3)
  const atStake = risk.money_at_stake ? Number(risk.money_at_stake) : null

  return (
    <section aria-labelledby="risk-h" className="mb-8 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="risk-h" className="font-heading text-base font-bold text-slate-900">Risk review</h2>
        <div className="flex gap-2">
          <Button icon="table_view" onClick={onExcel}>Excel risk matrix</Button>
          <Button icon="print" onClick={onPrint}><span className="max-sm:sr-only">Print / PDF</span></Button>
        </div>
      </div>

      {(noLayer3 || report.errors.length > 0) && (
        <div role="note" className="flex items-start gap-2.5 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <Icon name="warning" size={18} className="mt-px shrink-0" />
          <span>
            {noLayer3 ? 'The AI check (layer 3) did not run, so contradictions and scope gaps are not covered.' : 'Some checks reported errors.'}
            {report.errors.length > 0 && <> {plural(report.errors.length, 'error', 'errors')}: {report.errors.slice(0, 3).join('; ')}</>}
          </span>
        </div>
      )}

      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile label="Risk score" sub={live.score !== risk.score ? `${int(risk.score)} at upload` : undefined}>
          <span aria-live="polite">{int(live.score)} <span className={clsx('text-base', LEVEL[live.level].text)}>{LEVEL[live.level].label}</span></span>
          <span className="mt-1.5 block h-1.5 rounded-full bg-slate-200"><span className={clsx('block h-1.5 rounded-full transition-[width]', LEVEL[live.level].bar)} style={{ width: `${live.score}%` }} /></span>
        </Tile>
        <Tile label="Money at stake">{atStake != null && risk.priced ? money(atStake) : <span className="text-base text-slate-600">Not priced</span>}</Tile>
        <Tile label="Open errors / warnings">
          <span className="text-rose-700">{int(open.filter((f) => f.severity === 'error').length)}</span>
          <span className="text-slate-400"> / </span>
          <span className="text-amber-900">{int(open.filter((f) => f.severity === 'warning').length)}</span>
        </Tile>
        <Tile label="Change-order signals">{int(openSignals.length)}</Tile>
        <Tile label="Reviewed">{int(reviewed)} <span className="text-base font-medium text-slate-600">of {int(items)}</span></Tile>
      </dl>

      <section aria-labelledby="top-risks-h">
        <h3 id="top-risks-h" className="text-[15px] font-semibold text-slate-900">Top risks</h3>
        {top.length ? (
          <ol className="mt-2 divide-y divide-slate-200 rounded-lg ring-1 ring-slate-200">
            {top.map((t, i) => (
              <li key={t.line_id}>
                <button type="button" onClick={() => onOpen(t.line_id)} className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-slate-50">
                  <span className="num w-5 shrink-0 text-sm text-slate-500">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-900"><span className="num mr-2 text-slate-600">{t.line_code}</span>{t.short_text}</span>
                    <span className="block truncate text-[13px] text-slate-600">{t.reasons.join(' · ')}</span>
                  </span>
                  <span className="num shrink-0 text-sm font-semibold text-slate-900" title="Risk points">{int(t.live)} pts</span>
                </button>
              </li>
            ))}
          </ol>
        ) : <p className="mt-2 text-sm text-slate-600">Every risk has a decision.</p>}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <Bars title="Risk by section" rows={risk.by_section.map((s) => ({ key: s.section_id, label: `${s.code} ${s.title}`, value: s.points }))} />
        <Bars title="Risk by category (open)" rows={[...byCategory].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, label: CATEGORY[k] ?? k, value: v }))} />
      </div>

      {signals.length > 0 && (
        <section aria-labelledby="co-h">
          <h3 id="co-h" className="text-[15px] font-semibold text-slate-900">Change-order signals <span className="num ml-1 text-sm font-medium text-slate-600">{int(openSignals.length)} open</span></h3>
          <ul className="mt-2 space-y-3">
            {signals.map((s) => (
              <li key={s.id} className={clsx('flex flex-wrap items-start justify-between gap-2 border-l-[3px] pl-3', decisions[s.id] ? 'border-slate-300 opacity-70' : 'border-orange-500')}>
                <div className="min-w-0 flex-1 basis-64">
                  <p className="text-sm font-semibold text-slate-900">
                    {s.line_code && <button type="button" onClick={() => s.line_id && onOpen(s.line_id)} className="num mr-2 text-slate-600 underline underline-offset-4">{s.line_code}</button>}
                    {s.title}
                  </p>
                  <p className="text-sm text-slate-700">{s.message}</p>
                </div>
                <DecisionControls title={s.title} decision={decisions[s.id]} onDecide={(d) => onDecide([s.id], d)} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {byRule.length > 0 && (
        <section aria-labelledby="by-rule-h">
          <h3 id="by-rule-h" className="text-[15px] font-semibold text-slate-900">Repeated findings</h3>
          <ul className="mt-2 space-y-2">
            {byRule.map(([rule, r]) => (
              <li key={rule} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="min-w-0"><span className="font-semibold text-slate-900">{r.title}</span> <span className="num text-slate-600">· {int(r.ids.length)} open</span></span>
                <DismissMenu label={`Dismiss all ${r.ids.length}: ${r.title}`} onDismiss={(d) => onDecide(r.ids, d)}>{`Dismiss all ${r.ids.length}`}</DismissMenu>
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="group/all">
        <summary className="inline-flex min-h-10 cursor-pointer list-none items-center gap-1 text-[15px] font-semibold text-slate-900 [&::-webkit-details-marker]:hidden">
          <Icon name="chevron_right" size={18} className="transition-transform group-open/all:rotate-90" />
          All findings <span className="num ml-1 text-sm font-medium text-slate-600">{int(findings.length)}</span>
        </summary>
        <ul className="mt-2 divide-y divide-slate-200">
          {shown.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              {decisions[f.id] ? <span className="inline-flex h-6 items-center rounded-md bg-slate-100 px-1.5 text-[13px] font-semibold text-slate-700">{decisions[f.id].status === 'accepted' ? 'Accepted' : 'Dismissed'}</span> : <FindingBadge severity={f.severity}>{RISK_UI[f.severity].label}</FindingBadge>}
              <button type="button" onClick={() => f.target.line_id && onOpen(f.target.line_id)} className="min-w-0 flex-1 truncate text-left hover:underline">
                <span className="num mr-2 text-slate-600">{code(f)}</span>{f.title}
              </button>
            </li>
          ))}
        </ul>
        {pages > 1 && (
          <div className="mt-2 flex items-center gap-2 text-sm">
            <Button size="sm" icon="chevron_left" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous page" />
            <span className="num text-slate-700">Page {page + 1} of {pages}</span>
            <Button size="sm" icon="chevron_right" disabled={page >= pages - 1} onClick={() => setPage(page + 1)} aria-label="Next page" />
          </div>
        )}
      </details>
    </section>
  )
})
