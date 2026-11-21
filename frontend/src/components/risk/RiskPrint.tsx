import { useMemo } from 'react'
import { createPortal } from 'react-dom'
import { int, money } from '../../lib/format'
import { rescore, type Decisions, type Question, type Report, type ReviewItem, type Risk } from '../../lib/risk-assessment'
import { decisionText } from '../../lib/risk-export'
import { partialAnalysis } from '../../lib/risk-labels'

/** print-only copy of the risk review (see `.risk-print` in index.css); the app UI is hidden while printing */
export function RiskPrint({ title, report, risk, decisions, sections, questions, texts }: {
  title: string
  report: Report
  risk: Risk
  decisions: Decisions
  /** line id → OZ and section title */
  sections: Map<string, { oz: string; section: string }>
  questions: Question[]
  texts: Record<string, string>
}) {
  const live = rescore(risk, decisions)
  const partial = partialAnalysis(report.errors)
  const printedAt = useMemo(() => new Date().toLocaleDateString('de-DE'), [])
  const groups = new Map<string, ReviewItem[]>()
  for (const item of [...report.findings, ...risk.change_order_signals]) {
    const lineId = 'severity' in item ? item.target.line_id ?? item.related_line_ids[0] : item.line_id
    const key = (lineId && sections.get(lineId)?.section) || 'Whole list'
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  const atStake = risk.money_at_stake == null ? null : Number(risk.money_at_stake)
  return createPortal(
    <div className="risk-print">
      <h1>Risk review: {title}</h1>
      <p>
        Risk score {int(live.score)} ({live.level}) · Money at stake {atStake != null && Number.isFinite(atStake) && risk.priced
          ? money(atStake) : risk.priced ? 'Unavailable' : 'Not priced'} · {printedAt}
      </p>
      {partial && <p><b>Based on partial analysis.</b> {partial.message}</p>}
      <h2>Position review</h2>
      {[...groups].map(([section, findings]) => (
        <section key={section}>
          <h3>{section}</h3>
          <table>
            <thead><tr><th>OZ</th><th>Severity</th><th>Finding</th><th>Decision</th></tr></thead>
            <tbody>
              {findings.map((item) => {
                const finding = 'severity' in item
                const lineId = finding ? item.target.line_id ?? item.related_line_ids[0] : item.line_id
                const lineCode = finding ? item.target.line_code : item.line_code
                return (
                  <tr key={item.id}>
                    <td>{lineCode ?? (lineId && sections.get(lineId)?.oz) ?? ''}</td>
                    <td>{finding ? item.severity : 'Change-order signal'}</td>
                    <td><b>{item.title}</b>. {item.message}</td>
                    <td>{decisionText(decisions[item.id])}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      ))}
      {questions.length > 0 && (
        <>
          <h2>Bieterfragen</h2>
          <ol lang="de">{questions.map((q) => <li key={q.id}>{texts[q.id] ?? q.text_de}</li>)}</ol>
        </>
      )}
    </div>,
    document.body,
  )
}
