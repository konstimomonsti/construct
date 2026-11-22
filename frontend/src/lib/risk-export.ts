import { analysisCoverage, dependencyReviewLines, openExposure, openQuestions, openSections, REASONS, reportRisk, rescore, type Decision, type Decisions, type Finding, type Report, type Severity } from './risk-assessment'

const LAYER = ['', 'Layer 1 (rules)', 'Layer 2 (dependencies)', 'Layer 3 (AI)']
const SEVERITY_FILL: Record<Severity, string> = { error: 'FFFFC7CE', warning: 'FFFFEB9C', info: 'FFDDEBF7' }

export const decisionText = (d?: Decision) =>
  !d ? 'Open' : d.status === 'accepted' ? 'Accepted' : `Dismissed${d.reason ? ` (${REASONS[d.reason]})` : ''}`

/** the Bieterfragen as a formal German e-mail */
export function questionsMarkdown(title: string, texts: string[]) {
  return [
    'Sehr geehrte Damen und Herren,',
    '',
    `zur Ausschreibung „${title}“ bitten wir um Klärung der folgenden Punkte:`,
    '',
    ...texts.map((text, i) => `${i + 1}. ${text}`),
    '',
    'Für Ihre Rückmeldung vor Ablauf der Angebotsfrist bedanken wir uns.',
    '',
    'Mit freundlichen Grüßen',
    '',
  ].join('\n')
}

export type RiskExportInput = {
  title: string
  report: Report
  decisions: Decisions
  /** line id → OZ, for findings that do not carry their line code */
  codes: Map<string, string>
  /** edited Bieterfragen by question id */
  questionTexts?: Record<string, string>
  now?: Date
}

/** Excel risk matrix (Biel's spec §5A): Summary, Findings_Log and optional supporting sheets */
export async function riskXlsx({ title, report, decisions, codes, questionTexts = {}, now = new Date() }: RiskExportInput): Promise<Uint8Array> {
  const mod = await import('exceljs')
  const ExcelJS = (mod as unknown as { default?: typeof import('exceljs') }).default ?? mod
  const wb = new ExcelJS.Workbook()
  wb.creator = 'BillBuild'
  wb.created = now
  const header = (ws: import('exceljs').Worksheet, names: string[]) => {
    const row = ws.getRow(1)
    names.forEach((name, i) => (row.getCell(i + 1).value = name))
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } }
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: names.length } }
  }

  const risk = reportRisk(report)
  const coverage = analysisCoverage(report)
  const live = risk ? rescore(risk, decisions) : null
  const exposure = risk ? openExposure(risk, decisions) : null
  const findings = report.findings.filter((f) => f.category !== 'optimization')
  const optimizations = report.findings.filter((f) => f.category === 'optimization')
  const open = findings.filter((f) => !decisions[f.id])
  const summary = wb.addWorksheet('Summary')
  summary.columns = [{ width: 30 }, { width: 60 }]
  const rows: [string, string | number][] = [
    ['List', title],
    ['Exported', now.toISOString().slice(0, 10)],
    ...(live && risk ? [['Risk score', live.score], ['Risk level', live.level], ['Score at upload', risk.score]] as [string, string | number][] : []),
    ['Assessment', report.outdated ? 'Previous assessment' : 'Assessment results'],
    ['Analysis coverage', coverage.message],
    ...(report.totals ? [
      ['Working net', report.totals.working_net == null ? 'Unavailable' : `${report.totals.working_net} ${report.totals.currency ?? ''}`.trim()],
      ['Working net coverage', `${report.totals.counted_positions - report.totals.missing_amounts}/${report.totals.counted_positions} included positions priced`],
      ['Original net', report.totals.source_net ?? 'Unavailable for this revision'],
    ] as [string, string][] : []),
    ['Money at stake', exposure != null ? `${exposure} ${risk?.currency ?? ''}`.trim() : 'Unavailable'],
    ...(report.graph_valid === false ? [['Suggested fixes', 'Blocked by invalid references']] as [string, string][] : []),
    ['Findings', findings.length],
    ['Reviewed', `${findings.length - open.length} of ${findings.length}`],
    ['Open errors', open.filter((f) => f.severity === 'error').length],
    ['Open warnings', open.filter((f) => f.severity === 'warning').length],
    ['Open notes', open.filter((f) => f.severity === 'info').length],
    ['Layers run', (report.layers_run ?? []).join(', ')],
  ]
  rows.forEach(([k, v], i) => {
    const row = summary.getRow(i + 1)
    row.getCell(1).value = k
    row.getCell(1).font = { bold: true }
    row.getCell(2).value = v
  })
  if (coverage.details.length) {
    const row = summary.addRow(['Coverage details', coverage.details.join('\n')])
    row.font = { bold: true }
    row.alignment = { wrapText: true }
  }

  // one Bieterfrage per finding: the edited question text that covers it, else its own evidence
  const questionOf = new Map<string, string>()
  for (const q of openQuestions(report.questions ?? [], {})) for (const id of q.finding_ids) questionOf.set(id, questionTexts[q.id] ?? q.text_de)
  const lineCode = (f: Finding) => f.target.line_code ?? (f.target.line_id ? codes.get(f.target.line_id) : undefined) ?? f.target.section_id ?? ''

  const log = wb.addWorksheet('Findings_Log', { views: [{ state: 'frozen', ySplit: 1 }] })
  log.columns = [14, 30, 22, 10, 16, 14, 60, 45, 60, 22, 30].map((width) => ({ width }))
  header(log, ['OZ', 'Rule', 'Layer / source', 'Severity', 'Priority / Action', 'Category', 'Message', 'Recommended action', 'Bieterfrage', 'Decision', 'Reason / note'])
  findings.forEach((f, i) => {
    const d = decisions[f.id]
    const row = log.getRow(i + 2)
    row.values = [
      lineCode(f), f.rule_id, `${LAYER[f.layer] ?? `Layer ${f.layer}`}${f.origin === 'llm' && f.model ? ` · ${f.model}` : ''}`, f.severity,
      f.severity === 'error' ? 'Critical' : f.severity === 'warning' ? 'High' : 'Normal', f.category ?? '',
      [`${f.title}: ${f.message}`, ...dependencyReviewLines(f)].join('\n'), f.suggested_fix?.rationale ?? '', questionOf.get(f.id) ?? f.evidence?.bieterfrage_de ?? '',
      decisionText(d), [d?.reason ? REASONS[d.reason] : '', d?.note ?? ''].filter(Boolean).join(' – '),
    ]
    row.alignment = { wrapText: true, vertical: 'top' }
    row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SEVERITY_FILL[f.severity] } }
  })

  if (optimizations.length) {
    const sheet = wb.addWorksheet('Optimizations')
    sheet.columns = [{ width: 36 }, { width: 80 }]
    header(sheet, ['Suggestion', 'Details'])
    for (const finding of optimizations) sheet.addRow([finding.title, finding.message])
  }

  if (risk?.by_section.length) {
    const sections = wb.addWorksheet('Section_Risk')
    sections.columns = [15, 42, 15, 15].map(width => ({ width }))
    header(sections, ['OZ', 'Section', 'Open items', 'Risk points'])
    for (const section of openSections(risk, decisions)) {
      sections.addRow([section.code ?? '', section.title ?? 'Whole list', section.open, section.points])
    }
  }

  return new Uint8Array(await wb.xlsx.writeBuffer())
}

export function downloadBytes(name: string, data: Uint8Array | string, mime: string) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
