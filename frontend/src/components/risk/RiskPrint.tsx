import { useMemo } from 'react'
import { createPortal } from 'react-dom'
import { int } from '../../lib/format'
import { rescore, type Decisions, type Question, type Report, type Risk } from '../../lib/risk-assessment'
import { decisionText } from '../../lib/risk-export'

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
  const printedAt = useMemo(() => new Date().toLocaleDateString('de-DE'), [])
  const groups = new Map<string, typeof report.findings>()
  for (const f of report.findings) {
    const key = (f.target.line_id && sections.get(f.target.line_id)?.section) || 'Whole list'
    groups.set(key, [...(groups.get(key) ?? []), f])
  }
  const top = risk.top_risks.filter((t) => t.item_ids.some((id) => !decisions[id])).slice(0, 10)
  return createPortal(
    <div className="risk-print">
      <h1>Risk review: {title}</h1>
      <p>
        Score {int(live.score)} ({live.level}) · {int(report.findings.filter((f) => !decisions[f.id]).length)} open of {int(report.findings.length)} findings ·{' '}
        {int(risk.change_order_signals.filter((s) => !decisions[s.id]).length)} change-order signals · {printedAt}
      </p>
      <h2>Top risks</h2>
      <ol>{top.map((t) => <li key={t.line_id}><b>{t.line_code}</b> {t.short_text}: {t.reasons.join('; ')}</li>)}</ol>
      <h2>Findings by section</h2>
      {[...groups].map(([section, findings]) => (
        <section key={section}>
          <h3>{section}</h3>
          <table>
            <thead><tr><th>OZ</th><th>Severity</th><th>Finding</th><th>Decision</th></tr></thead>
            <tbody>
              {findings.map((f) => (
                <tr key={f.id}>
                  <td>{f.target.line_code ?? (f.target.line_id && sections.get(f.target.line_id)?.oz) ?? ''}</td>
                  <td>{f.severity}</td>
                  <td><b>{f.title}</b>. {f.message}</td>
                  <td>{decisionText(decisions[f.id])}</td>
                </tr>
              ))}
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
