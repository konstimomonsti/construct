/**
 * A contract v0.2 report (CLAUDE.md §5.4) for the bundled LV 11 list (position ids p0…p8).
 * The UI uses it with `?risk=fixture` on a list page until task 03 serves real reports.
 */
import type { Finding, Report } from '../../src/lib/risk-assessment'

const line = (id: string, code: string) => ({ line_id: id, line_code: code, section_id: null })

const findings: Finding[] = [
  {
    id: 'f_din_grade', layer: 1, rule_id: 'L1.DIN.EXPOSURE_GRADE', category: 'din', severity: 'error', scope: 'line',
    title: 'Concrete grade below DIN 1045-2 minimum', message: 'C25/30 is specified, but exposure classes XC4 and XF1 need at least C30/37.',
    target: { ...line('p1', '3.2.20'), field: 'long_text' }, related_line_ids: [],
    evidence: { din: { grade: 'C25/30', exposure: ['XC4', 'XF1'], required_min: 'C30/37' }, bieterfrage_de: 'Zu Pos. 3.2.20: Die angegebene Betonfestigkeitsklasse C25/30 erfüllt die Expositionsklassen XC4/XF1 nach DIN 1045-2 nicht (mindestens C30/37). Bitte bestätigen Sie die geforderte Festigkeitsklasse.' },
    suggested_fix: { rationale: 'Raise the grade to C30/37 or confirm a lower exposure class with the client.' }, origin: 'rule', model: null,
  },
  ...(['p1', 'p2', 'p3'] as const).map((id, i): Finding => ({
    id: `f_spec_${id}`, layer: 3, rule_id: 'L3.PRECAST.MISSING_SPEC', category: 'text', severity: 'warning', scope: 'line',
    title: 'Element height and insulation thickness missing', message: 'The sandwich element names its length but not its height or core insulation thickness, so weight and transport cannot be priced.',
    target: { ...line(id, `3.2.${20 + i * 10}`), field: 'long_text' }, related_line_ids: [],
    evidence: { extracted: { element: `FS 0${i + 1}`, length_m: ['6,35', '7,00', '1,25'][i], height_m: null, insulation_mm: null, concrete_grade: 'C25/30' } },
    suggested_fix: { rationale: 'Ask for the element drawings or a type schedule with height and insulation.' }, origin: 'llm', model: 'claude-haiku-5-5',
  })),
  {
    id: 'f_shop_drawings', layer: 2, rule_id: 'L2.PRECAST.SHOP_DRAWINGS_SCOPE', category: 'dependency', severity: 'warning', scope: 'line',
    title: 'Shop drawing scope unclear', message: 'Werkstattzeichnungen are a lump sum, but the text does not say whether static calculations and approvals are included.',
    target: { ...line('p0', '3.2.10'), field: 'long_text' }, related_line_ids: [],
    evidence: { change_order: true }, suggested_fix: null, origin: 'rule', model: null,
  },
  {
    id: 'f_rebar_unit', layer: 1, rule_id: 'L1.UNIT.TRADE_MISMATCH', category: 'unit', severity: 'warning', scope: 'line',
    title: 'Unit unusual for this trade', message: 'Rebar in precast elements is usually included in the element price; a separate tonnage line can double-count.',
    target: { ...line('p6', '3.2.70'), field: 'unit' }, related_line_ids: [], evidence: {}, suggested_fix: null, origin: 'rule', model: null,
  },
  {
    id: 'f_rebar_scope', layer: 3, rule_id: 'L3.SCOPE.REBAR_UNCLEAR', category: 'scope', severity: 'warning', scope: 'line',
    title: 'Rebar scope overlaps the elements', message: '0,7 t of rebar is listed separately while 3.2.20–3.2.60 are complete reinforced elements.',
    target: { ...line('p6', '3.2.70'), field: 'quantity' }, related_line_ids: ['p1', 'p2'],
    evidence: { change_order: true, extracted: { quantity_t: '0,7', applies_to: '3.2.20–3.2.60' } },
    suggested_fix: { rationale: 'Clarify whether 3.2.70 is extra rebar for in-situ joints only.' }, origin: 'llm', model: 'claude-sonnet-5-5',
  },
  {
    id: 'f_dimension', layer: 1, rule_id: 'L1.TEXT.UNCLEAR_DIMENSION', category: 'text', severity: 'warning', scope: 'line',
    title: 'Dimension without a reference', message: '"Länge=150 mm" does not say which part of the anchor it measures.',
    target: { ...line('p8', '3.2.90'), field: 'short_text' }, related_line_ids: [], evidence: {}, suggested_fix: null, origin: 'rule', model: null,
  },
  ...(['p4', 'p5'] as const).map((id, i): Finding => ({
    id: `f_din_note_${id}`, layer: 1, rule_id: 'L1.DIN.NOTE', category: 'din', severity: 'info', scope: 'line',
    title: 'Exposure class not stated', message: 'No exposure class is given for this outdoor element.',
    target: { ...line(id, `3.2.${50 + i * 10}`), field: 'long_text' }, related_line_ids: [],
    evidence: { din: { grade: 'C25/30', exposure: [] } }, suggested_fix: null, origin: 'rule', model: null,
  })),
]

const points: Record<string, number> = {
  f_din_grade: 8, f_spec_p1: 4, f_spec_p2: 4, f_spec_p3: 4, f_shop_drawings: 6, f_rebar_unit: 4, f_rebar_scope: 6,
  f_dimension: 4, f_din_note_p4: 1, f_din_note_p5: 1, 'co_3.2.70_rebar': 5, 'co_3.2.80_zulage': 3,
}

export const riskReport: Report = {
  findings,
  errors: [],
  source_notice: null,
  layers_run: [1, 2, 3],
  summary: { findings: findings.length },
  risk: {
    version: 'risk/1',
    score: 56, // 50 open points, scale 40
    level: 'high',
    scale: 40,
    priced: false,
    currency: 'EUR',
    money_at_stake: null,
    points,
    open_counts: { error: 1, warning: 7, info: 2 },
    top_risks: [
      { line_id: 'p6', line_code: '3.2.70', short_text: 'Betonstahl 500 S und 500 M', points: 15, amount: null, reasons: ['Rebar scope overlaps the elements', 'Unit unusual for this trade', 'Vague quantity'], item_ids: ['f_rebar_scope', 'f_rebar_unit', 'co_3.2.70_rebar'] },
      { line_id: 'p1', line_code: '3.2.20', short_text: 'FS 01: FT-Sockel, Sandwichelement, l=6,35m', points: 12, amount: null, reasons: ['Concrete grade below DIN 1045-2 minimum', 'Element height and insulation thickness missing'], item_ids: ['f_din_grade', 'f_spec_p1'] },
      { line_id: 'p0', line_code: '3.2.10', short_text: 'Werkstattzeichnungen', points: 6, amount: null, reasons: ['Shop drawing scope unclear'], item_ids: ['f_shop_drawings'] },
      { line_id: 'p2', line_code: '3.2.30', short_text: 'FS 02: FT-Sockel, Sandwichelement, l=7,00m', points: 4, amount: null, reasons: ['Element height and insulation thickness missing'], item_ids: ['f_spec_p2'] },
      { line_id: 'p3', line_code: '3.2.40', short_text: 'FS 03: FT-Sockel, Sandwichelement, l=1,25m', points: 4, amount: null, reasons: ['Element height and insulation thickness missing'], item_ids: ['f_spec_p3'] },
      { line_id: 'p8', line_code: '3.2.90', short_text: 'Länge=150 mm', points: 4, amount: null, reasons: ['Dimension without a reference'], item_ids: ['f_dimension'] },
      { line_id: 'p7', line_code: '3.2.80', short_text: 'Zulage Aussparungen Öffnungen Tür und Tore', points: 3, amount: null, reasons: ['Provisional item'], item_ids: ['co_3.2.80_zulage'] },
      { line_id: 'p4', line_code: '3.2.50', short_text: 'FS 04: FT-Sockel, Sandwichelement, l=3,90m', points: 1, amount: null, reasons: ['Exposure class not stated'], item_ids: ['f_din_note_p4'] },
      { line_id: 'p5', line_code: '3.2.60', short_text: 'FS 05: FT-Sockel, Sandwichelement, l=2,17m', points: 1, amount: null, reasons: ['Exposure class not stated'], item_ids: ['f_din_note_p5'] },
    ],
    by_section: [
      { section_id: 's-3.2', code: '3.2', title: 'Stahlbetonfertigteile', points: 50, open: 12 },
    ],
    by_category: { text: 16, din: 10, dependency: 6, scope: 6, unit: 4 },
    change_order_signals: [
      { id: 'co_3.2.70_rebar', kind: 'vague_quantity', line_id: 'p6', line_code: '3.2.70', title: 'Rebar quantity is an estimate', message: '0,7 t without a schedule; extra tonnage is usually claimed as a change order.', points: 5, finding_ids: ['f_rebar_scope'] },
      { id: 'co_3.2.80_zulage', kind: 'provisional', line_id: 'p7', line_code: '3.2.80', title: 'Surcharge item (Zulage)', message: 'Openings are priced as a surcharge per metre without a quantity basis.', points: 3, finding_ids: [] },
    ],
  },
  questions: [
    { id: 'q_spec', topic: 'Fehlende Angaben', text_de: 'Zu Pos. 3.2.20 – 3.2.40: Bitte teilen Sie uns die Elementhöhen und die Dämmstärke der Sandwichelemente mit oder stellen Sie die Elementpläne zur Verfügung.', line_codes: ['3.2.20', '3.2.30', '3.2.40'], finding_ids: ['f_spec_p1', 'f_spec_p2', 'f_spec_p3'], rule_id: 'L3.PRECAST.MISSING_SPEC' },
    { id: 'q_din', topic: 'Betonfestigkeit', text_de: 'Zu Pos. 3.2.20: Die angegebene Betonfestigkeitsklasse C25/30 erfüllt die Expositionsklassen XC4/XF1 nach DIN 1045-2 nicht (mindestens C30/37). Bitte bestätigen Sie die geforderte Festigkeitsklasse.', line_codes: ['3.2.20'], finding_ids: ['f_din_grade'], rule_id: 'L1.DIN.EXPOSURE_GRADE' },
    { id: 'q_rebar', topic: 'Leistungsumfang', text_de: 'Zu Pos. 3.2.70: Ist der Betonstahl zusätzlich zur Bewehrung der Fertigteile (Pos. 3.2.20 – 3.2.60) zu liefern, oder ist er bereits in den Elementpreisen enthalten?', line_codes: ['3.2.70'], finding_ids: ['f_rebar_scope'], rule_id: 'L3.SCOPE.REBAR_UNCLEAR' },
    { id: 'q_shop', topic: 'Leistungsumfang', text_de: 'Zu Pos. 3.2.10: Sind statische Berechnungen und Prüfstatik in der Position Werkstattzeichnungen enthalten?', line_codes: ['3.2.10'], finding_ids: ['f_shop_drawings'], rule_id: 'L2.PRECAST.SHOP_DRAWINGS_SCOPE' },
  ],
}
