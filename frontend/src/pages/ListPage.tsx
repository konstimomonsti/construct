import { clsx } from 'clsx'
import { lazy, Suspense, use, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Button, Dialog, Field, Icon, inputCls, kbdCls, toast, type MenuItem } from '../components/ui'
import { raisedCls } from '../lib/cls'
import { TableSkeleton } from '../components/Page'
import { EmptyState, MetaLink, PageFrame, PageHeader, RowMenu, SortMenu, ToolButton } from '../components/Kit'
import { PhaseHeader, PhasePanel, isPhase, type Phase } from '../components/project/PhaseHeader'
import { SubcontractorsTab } from '../components/project/SubcontractorsTab'
import { OfferTab } from '../components/project/OfferTab'
import { AwardTab } from '../components/project/AwardTab'
import { SubcontractOverlay } from '../components/subcontract/SubcontractOverlay'
import type { SubcontractPackage } from '../lib/subcontract'
import { currentPhase } from '../lib/workflow'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { LedgerTable } from '../components/LedgerTable'
import { BidSimulator } from '../components/BidSimulator'
import { ChangeOrderText, FindingFilter, FindingText } from '../components/RiskAssessment'
import { analysisCoverage, assessmentMatchesEdits, canApplyAssessmentFix, currentDecisions, decisionsOf, indexFindings, matchesFindingFilter, openQuestions, reportRisk, SEVERITIES, useUploadAssessment, type Assessment, type ChangeOrderSignal, type Decision, type Finding, type Question, type Report, type ReviewItem } from '../lib/risk-assessment'
import { riskXlsx, downloadBytes } from '../lib/risk-export'
import type { RowRisk } from '../components/LedgerTable'
import { DecisionControls, DismissMenu } from '../components/risk/DecisionControls'
import { WarningsPanel, type WarningEntry } from '../components/risk/WarningsPanel'
import { runSteps, type FixPlan } from '../lib/apply-fix'
import { FindingQuestions } from '../components/risk/BidderQuestions'
import { RiskPrint } from '../components/risk/RiskPrint'
import { AddSectionDialog, PricingLegend, PricingBreakdown, pricingSections } from '../components/PricingSummary'
import { useActions } from '../lib/actions'
import { DetailDrawer } from '../components/DetailDrawer'
import { loadList } from '../lib/data'
import { ExportMenu } from '../components/ExportMenu'
import { CatalogueDetails, CatalogueOverview } from '../components/WorkspaceCatalogue'
import { researchFilterOf, useWorkspaceCatalogue, type ResearchFilter } from '../lib/workspace-catalogue'
import { matchesPricingFilter, usePriceSuggestions, type PriceSuggestion, type PricingFilter } from '../lib/price-suggestions'
import { CategoryTree, useExpanded, type CheckState } from '../components/split/CategoryTree'
import { MoveToCategory } from '../components/split/MoveToCategory'
import { budgetMoney, budgetStatus, int, money, parseNumber, plural } from '../lib/format'
import { positionTotal } from '../lib/money'
import { groupByOz, hasSectionLabel } from '../lib/oz-groups'
import { applyMoves, globalStep, indexTree, leafOz, nextChildOz, nextPositionOz, pathOf, resolveList, treeStats, type CatStat } from '../lib/resolve'
import { selectModel, statsOf, useModel, useStore } from '../lib/store'
import { useUi } from '../lib/ui-store'
import type { CategoryNode, ListDoc, Position } from '../lib/types'

const SplitOverlay = lazy(() => import('../components/split/SplitOverlay').then((m) => ({ default: m.SplitOverlay })))

const PRICING_FILTERS = {
  unpriced: 'Not priced',
  pending: 'Pending confirmation',
  zero: 'Priced with quantity 0',
  edited: 'Edited',
} satisfies Record<PricingFilter, string>
const PRICING_FILTER_KEYS = Object.keys(PRICING_FILTERS) as PricingFilter[]

const CATALOGUE_FILTERS = {
  matched: 'Catalogue matches',
  suggested: 'Web suggestions',
  unresolved: 'Without a match',
} satisfies Record<ResearchFilter, string>
type PositionFilter = { pricing: PricingFilter } | { catalogue: ResearchFilter }

export function ListPage() {
  const { listId = '' } = useParams()
  const syncReady = useStore((s) => s.syncReady)
  const purged = useStore((s) => s.listPatch[listId]?.trashedAt === 'purged'
    || selectModel(s).lists.some((list) => list.id === listId && list.trashedAt === 'purged'))
  useEffect(() => {
    if (listId && syncReady && !purged) useStore.getState().openTab(listId)
  }, [listId, syncReady, purged])
  if (purged) return (
    <PageFrame>
      <EmptyState icon="description" title="List not found" text="It may have been deleted permanently.">
        <Link to="/" className="font-semibold text-brand-700 hover:underline">Back to All Projects</Link>
      </EmptyState>
    </PageFrame>
  )
  if (!syncReady) return <PageFrame><TableSkeleton /></PageFrame>
  // from sm up the left padding grows by 24px to make room for the crane tower, and so does the frame,
  // so the content keeps its width wherever the page is wide enough
  return (
    <PageFrame className="flex grow flex-col pb-0! sm:max-w-[1144px] sm:pl-14">
      <ErrorBoundary key={listId}>
        <Suspense fallback={<TableSkeleton />}>
          <Loaded id={listId} />
        </Suspense>
      </ErrorBoundary>
    </PageFrame>
  )
}

function Loaded({ id }: { id: string }) {
  const doc = use(loadList(id))
  return <ListDetail key={doc.id} doc={doc} />
}

/* ------------------------------------------------------------------ */
/* Category filter                                                     */
/* ------------------------------------------------------------------ */

const pillCls = (on: boolean) =>
  clsx(
    'inline-flex h-10 shrink-0 items-center gap-2 rounded-md px-3.5 text-sm whitespace-nowrap transition-colors',
    on ? 'bg-slate-900 font-semibold text-white hover:bg-slate-800' : [raisedCls, 'font-medium'],
  )

/** toggles one quick filter; the pressed state is the filter's only visible state */
function FilterPill({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={pillCls(on)}>
      {children}
      {on && <Icon name="close" size={16} />}
    </button>
  )
}

function CategoryFilter({ tree, stats, value, onChange, byOz }: { tree: CategoryNode[]; stats: Map<string, CatStat>; value: Set<string> | null; onChange: (v: Set<string> | null) => void; byOz: boolean }) {
  const label = byOz ? 'OZ groups' : 'Categories'
  const filterLabel = byOz ? 'Filter by OZ group' : 'Filter by category'
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const id = useId()
  const ex = useExpanded(tree, 'all')
  const idx = useMemo(() => indexTree(tree), [tree])
  const allOz = useMemo(() => [...idx.node.keys()], [idx])
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus()
    }
    // focus moves into the panel so keyboard users land on the search field
    requestAnimationFrame(() => search.current?.focus())
    window.addEventListener('pointerdown', down)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('keydown', key)
    }
  }, [open])
  const subtree = (oz: string): string[] => {
    const out: string[] = []
    const walk = (n: CategoryNode) => (out.push(n.oz), n.children.forEach(walk))
    const n = idx.node.get(oz)
    if (n) walk(n)
    return out
  }
  const checkState = (_k: 'cat' | 'pos', oz: string): CheckState => {
    if (!value) return 'on'
    const ids = subtree(oz)
    const n = ids.filter((x) => value.has(x)).length
    return n === 0 ? 'off' : n === ids.length ? 'on' : 'mixed'
  }
  const toggle = (_k: 'cat' | 'pos', oz: string) => {
    const cur = new Set(value ?? allOz)
    const ids = subtree(oz)
    if (ids.every((x) => cur.has(x))) ids.forEach((x) => cur.delete(x))
    else ids.forEach((x) => cur.add(x))
    onChange(cur.size === allOz.length ? null : cur)
  }
  return (
    <div
      ref={root}
      className="relative inline-block"
      onBlur={(e) => {
        if (open && e.relatedTarget && !root.current?.contains(e.relatedTarget as Node)) setOpen(false)
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={pillCls(!!value)}
      >
        <Icon name="filter_list" size={18} />
        <span>{value ? `${value.size} of ${allOz.length} ${label.toLowerCase()}` : label}</span>
        <Icon name="expand_more" size={18} className={clsx('transition-transform', open && 'rotate-180')} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            id={id}
            role="dialog"
            aria-label={filterLabel}
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className="absolute left-0 z-40 mt-2 w-[26rem] max-w-[calc(100vw-2rem)] rounded-lg bg-white p-2 shadow-[0_8px_20px_-8px_var(--pop-shadow)] ring-1 ring-slate-300"
          >
            <div className="flex items-center gap-2 px-1.5 py-1.5">
              <input ref={search} aria-label={`Search ${label.toLowerCase()}`} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${label.toLowerCase()}…`} className="h-10 min-w-0 flex-1 rounded-md bg-white px-4 text-sm ring-1 ring-slate-500 outline-none ring-inset placeholder:text-slate-500 hover:ring-slate-600 focus:ring-2 focus:ring-brand-600" />
              <span className="flex gap-1 text-sm font-semibold text-slate-800">
                <button type="button" className="h-10 rounded-md px-3 hover:bg-slate-100" onClick={() => onChange(null)}>All</button>
                <button type="button" className="h-10 rounded-md px-3 hover:bg-slate-100" onClick={() => onChange(new Set())}>None</button>
              </span>
            </div>
            <div className="max-h-80 overflow-y-auto">
              <CategoryTree tree={tree} stats={stats} expanded={ex.expanded} onToggleExpand={ex.toggle} mode="check" label={filterLabel} query={query} checkState={checkState} onToggle={toggle} showCategoryCode={!byOz} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Add item                                                            */
/* ------------------------------------------------------------------ */

function AddItemDialog({ open, onClose, listId, tree, positions }: { open: boolean; onClose: () => void; listId: string; tree: CategoryNode[]; positions: Position[] }) {
  const [f, setF] = useState({ oz: '', short: '', qty: '1', unit: 'St', up: '', cat: '' })
  const index = useMemo(() => indexTree(tree), [tree])
  const path = pathOf(index, f.cat)
  const taken = new Set(positions.map((position) => position.oz))
  const nextOz = nextPositionOz(f.cat, positions.filter((position) => leafOz(position) === f.cat).map((position) => position.oz), taken, globalStep(positions))
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((s) => ({ ...s, [k]: e.target.value }))
  const num = (s: string) => parseNumber(s) ?? NaN
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!f.short.trim()) return
    if (taken.has(f.oz.trim())) {
      toast('That OZ is already in use', 'error')
      return
    }
    const q = f.qty.trim() === '' ? 1 : num(f.qty)
    const up = f.up.trim() === '' ? null : num(f.up)
    if (!Number.isFinite(q) || q < 0 || (up !== null && !Number.isFinite(up))) {
      toast('Please enter valid numbers for quantity and price', 'error')
      return
    }
    const p: Position = {
      id: `u-${crypto.randomUUID()}`,
      oz: f.oz.trim() || nextOz,
      short: f.short.trim(),
      qty: q,
      unit: f.unit.trim() || 'St',
      up,
      category: path.at(-1)?.label ?? 'Eigene Positionen',
      path: path.length ? path : undefined,
    }
    useStore.getState().addPosition(listId, p)
    toast(`Added ${p.oz}`)
    setF({ oz: '', short: '', qty: '1', unit: 'St', up: '', cat: '' })
    onClose()
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add position"
      description="Adds a new position to this list."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="add-item-form" disabled={!f.short.trim()}>Add position</Button>
        </>
      }
    >
      <form id="add-item-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="OZ"><input className={`${inputCls} num`} value={f.oz} onChange={set('oz')} placeholder={nextOz} /></Field>
        <Field label="Einheit"><input className={inputCls} value={f.unit} onChange={set('unit')} placeholder="St, m, m2, psch" /></Field>
        <div className="col-span-2">
          <Field label="Kurztext"><input data-autofocus className={inputCls} value={f.short} onChange={set('short')} maxLength={200} /></Field>
        </div>
        <Field label="Menge"><input inputMode="decimal" className={`${inputCls} num`} value={f.qty} onChange={set('qty')} /></Field>
        <Field label="Einheitspreis (€)"><input inputMode="decimal" className={`${inputCls} num`} value={f.up} onChange={set('up')} placeholder="optional" /></Field>
        <div className="col-span-2">
          <Field label="Kategorie">
            <select className={inputCls} value={f.cat} onChange={set('cat')}>
              <option value="">Eigene Positionen</option>
              {[...index.node.values()].map((category) => (
                <option key={category.oz} value={category.oz}>{pathOf(index, category.oz).map((part) => part.label || part.oz).join(' / ')}</option>
              ))}
            </select>
          </Field>
        </div>
      </form>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/* Detail                                                              */
/* ------------------------------------------------------------------ */

/** `?risk=fixture` shows the contract v0.2 sample report (LV 11) until the backend serves risk reports */
function useFixtureReport(on: boolean) {
  const [report, setReport] = useState<Report | null>(null)
  useEffect(() => {
    if (on) void import('../../tests/fixtures/risk-report').then((m) => setReport(m.riskReport))
  }, [on])
  return on ? report : null
}

/** `?demo=workflow` shows demo subcontractor packages (tests/fixtures/workflow-demo.ts). They are never written to the store. */
function useWorkflowDemo(on: boolean) {
  const [demo, setDemo] = useState<typeof import('../../tests/fixtures/workflow-demo') | null>(null)
  useEffect(() => {
    if (on) void import('../../tests/fixtures/workflow-demo').then(setDemo)
  }, [on])
  return on ? demo : null
}

const NO_PACKAGES: SubcontractPackage[] = []

function ListDetail({ doc: imported }: { doc: ListDoc }) {
  const [params, setParams] = useSearchParams()
  const tab: Phase = isPhase(params.get('phase')) ? (params.get('phase') as Phase) : 'x83'
  const setTab = (next: Phase) => setParams((prev) => {
    const out = new URLSearchParams(prev)
    if (next === 'x83') out.delete('phase')
    else out.set('phase', next)
    return out
  }, { replace: true })
  const [sending, setSending] = useState(false)
  const { lists, folders, documents } = useModel()
  const attached = documents.filter((document) => document.listId === imported.id)
  const original = attached.find((document) => document.original && document.name === imported.fileName)
  const catalogueEnabled = Boolean(imported.userCreated && imported.source?.kind && imported.source.kind !== 'blank' && imported.positions.length)
  const documentVersion = useStore((state) => attached.map(({ id }) =>
    [id, state.sync?.hashes.userDocuments?.[id], state.sync?.hashes.documentLinks?.[id]].join(':'),
  ).join(','))
  const { report, error, retryFailed } = useWorkspaceCatalogue(catalogueEnabled ? imported.id : null, documentVersion)
  const doc = useMemo(() => {
    if (!report) return imported
    const positions = imported.positions.map((position) => {
      const recovered = report.positions[position.id]?.recovered
      return recovered ? { ...position, short: recovered.short, long: recovered.long || undefined } : position
    })
    return { ...imported, positions }
  }, [imported, report])
  const openDialog = useUi((s) => s.openDialog)
  const { listMenu } = useActions()
  const view = lists.find((l) => l.id === doc.id)
  const folder = folders.find((f) => f.id === (view?.folderId ?? doc.folderId))
  const edits = useStore((s) => s.edits[doc.id])
  const resolved = useMemo(() => resolveList(doc, edits), [doc, edits])
  const positions = resolved.positions
  const bidStandardRates = useMemo(() => {
    if (!original || imported.phase !== 'X83') return new Map<string, number>()
    const units = new Map(imported.positions.map((p) => [p.id, p.unit]))
    return new Map(positions.flatMap((p) => p.up != null && p.unit === units.get(p.id) ? [[p.id, p.up] as const] : []))
  }, [original, imported.phase, imported.positions, positions])
  const tree = resolved.tree
  const catStats = useMemo(() => treeStats(positions), [positions])
  const ozGroups = useMemo(() => groupByOz(positions), [positions])
  const [grouping, setGrouping] = useState<'category' | 'oz'>(() =>
    imported.positions.length > 0 && imported.positions.every((p) => !hasSectionLabel(p.path?.at(-1)?.label || p.category)) ? 'oz' : 'category',
  )
  const grouped = grouping === 'oz' ? ozGroups : null
  const ledgerGrouping = grouped ? 'oz' : 'category'
  const ledgerTree = grouped?.tree ?? tree
  const ledgerPositions = grouped?.positions ?? positions
  const ledgerStats = useMemo(() => grouped ? treeStats(grouped.positions) : catStats, [grouped, catStats])
  // prices proposed from matched catalogue products: pending until confirmed, never counted in totals
  const dismissedPrices = useStore((s) => s.listPatch[doc.id]?.dismissedPrices)
  const pending = usePriceSuggestions(report, positions, dismissedPrices)
  // workflow tabs: subcontractor packages (plus read-only demo ones) and the award document
  const storedPackages = useStore((s) => s.listPatch[doc.id]?.subcontractPackages) ?? NO_PACKAGES
  const workflowDemo = useWorkflowDemo(params.get('demo') === 'workflow')
  const { packages, demoIds } = useMemo(() => {
    const held = new Set(storedPackages.map((p) => p.id))
    const extra = (workflowDemo?.demoPackages ?? []).filter((p) => !held.has(p.id))
    return { packages: [...storedPackages, ...extra], demoIds: new Set(extra.map((p) => p.id)) }
  }, [storedPackages, workflowDemo])
  const awardId = useStore((s) => s.listPatch[doc.id]?.awardDocumentId)
  const award = awardId ? documents.find((d) => d.id === awardId) : undefined
  const st = useMemo(() => statsOf(positions), [positions])
  // findings from the automatic check that runs once on upload
  const assessment = useUploadAssessment(catalogueEnabled && original ? imported.id : null)
  const fixtureReport = useFixtureReport(params.get('risk') === 'fixture')
  const rawUploadReport = fixtureReport ?? (assessment && 'report' in assessment && assessment.report ? assessment.report : null)
  const uploadReport = useMemo(() => {
    if (!rawUploadReport) return null
    if (!fixtureReport) return rawUploadReport
    const byCode = new Map(positions.map(p => [p.oz, p.id]))
    return { ...rawUploadReport, findings: rawUploadReport.findings.map(finding => {
      const ids = new Map<string, string>()
      if (finding.target.line_id && finding.target.line_code && byCode.has(finding.target.line_code)) ids.set(finding.target.line_id, byCode.get(finding.target.line_code)!)
      for (const key of ['trigger_items', 'dependency_items', 'unassigned_candidate_items']) {
        const entries = finding.evidence?.[key]
        if (Array.isArray(entries)) for (const entry of entries) {
          if (entry && typeof entry.id === 'string' && typeof entry.code === 'string' && byCode.has(entry.code)) ids.set(entry.id, byCode.get(entry.code)!)
        }
      }
      const map = (id: string) => ids.get(id) ?? id
      const operations = finding.suggested_fix?.operations?.map(op => {
        if (op.op === 'set_field' || op.op === 'remove_line' || op.op === 'link_alternative') return { ...op, line_id: map(op.line_id) }
        if (op.op === 'add_line') return { ...op, after_line_id: op.after_line_id ? map(op.after_line_id) : null }
        return { ...op, keep_line_id: map(op.keep_line_id), remove_line_ids: op.remove_line_ids.map(map) }
      })
      return { ...finding, target: { ...finding.target, line_id: finding.target.line_id ? map(finding.target.line_id) : null }, related_line_ids: finding.related_line_ids.map(map), suggested_fix: finding.suggested_fix ? { ...finding.suggested_fix, operations } : null }
    }) }
  }, [rawUploadReport, fixtureReport, positions])
  const isStale = !fixtureReport && !!uploadReport && !assessmentMatchesEdits(uploadReport, edits)
  const fixesAvailable = !fixtureReport && canApplyAssessmentFix(assessment, edits)
  const confirmedCap = useStore(s => s.listPatch[doc.id]?.capApproval)
  const cap = isStale ? undefined : uploadReport?.cap_comparison
  const comparableCap = cap && 'cap' in cap && cap.confirmation_reference === confirmedCap?.confirmationReference
    && Number(cap.cap) === Number(confirmedCap.amount) && cap.currency === confirmedCap.currency ? cap : undefined
  const phase = !isStale ? uploadReport?.phase_validation : undefined
  const workflow = useMemo(() => currentPhase(packages, phase?.state === 'verified' && /86$/i.test(imported.phase ?? ''), positions.length > 0 && positions.every(p => p.up != null)), [packages, phase, imported.phase, positions])
  const risk = useMemo(() => reportRisk(uploadReport), [uploadReport])
  const coverage = uploadReport ? analysisCoverage(uploadReport) : null
  const analysisErrors = uploadReport?.errors.filter((error) =>
    !/^layer 3 coverage:/i.test(error) && !coverage?.details.includes(error),
  ) ?? []
  const reviewedIds = useStore((s) => s.listPatch[doc.id]?.reviewedFindings)
  const decisionMap = useStore((s) => s.listPatch[doc.id]?.findingDecisions)
  const decisions = useMemo(() => currentDecisions(decisionsOf({ findingDecisions: decisionMap, reviewedFindings: reviewedIds }), uploadReport), [decisionMap, reviewedIds, uploadReport])
  const reviewKeys = useMemo(() => new Map(uploadReport?.findings.map(finding => [finding.id, finding.review_key])), [uploadReport])
  const reviewed = useMemo(() => new Set(Object.keys(decisions)), [decisions])
  const questionTexts: Record<string, string> = {}
  const questions = useMemo(() => openQuestions(uploadReport?.questions ?? [], decisions), [uploadReport, decisions])
  const questionsByFinding = useMemo(() => {
    const index = new Map<string, Question[]>()
    if (isStale) return index
    for (const question of questions) {
      for (const id of question.finding_ids) {
        if (decisions[id]?.status === 'dismissed') continue
        const linked = index.get(id) ?? []
        linked.push(question)
        index.set(id, linked)
      }
    }
    return index
  }, [questions, decisions, isStale])
  const codes = useMemo(() => new Map(imported.positions.map((p) => [p.id, p.oz])), [imported.positions])
  const { byRow: findingsByRow, listWide, optimizations } = useMemo(() => {
    const findings = uploadReport?.findings ?? []
    return {
      ...indexFindings(findings.filter(finding => finding.category !== 'optimization'), positions),
      optimizations: findings.filter(finding => finding.category === 'optimization'),
    }
  }, [uploadReport, positions])
  const { signalsByRow, listSignals } = useMemo(() => {
    const signalsByRow = new Map<string, ChangeOrderSignal[]>()
    const listSignals: ChangeOrderSignal[] = []
    const positionIds = new Set(positions.map((position) => position.id))
    for (const signal of risk?.change_order_signals ?? []) {
      if (signal.line_id && positionIds.has(signal.line_id)) {
        const items = signalsByRow.get(signal.line_id) ?? []
        items.push(signal)
        signalsByRow.set(signal.line_id, items)
      } else {
        listSignals.push(signal)
      }
    }
    return { signalsByRow, listSignals }
  }, [risk, positions])
  const reviewByRow = useMemo(() => {
    const items = new Map<string, ReviewItem[]>(findingsByRow)
    for (const [id, signals] of signalsByRow) items.set(id, [...(findingsByRow.get(id) ?? []), ...signals])
    return items
  }, [findingsByRow, signalsByRow])
  // a finding about a field the user has since edited no longer describes the position: show it as
  // "changed since upload" instead of flagging the row with an error the edit may already have fixed
  const changedFindings = useMemo(() => {
    if (uploadReport?.assessed_revision != null) {
      return new Set(isStale ? uploadReport.findings.map(finding => finding.id) : [])
    }
    const out = new Set<string>()
    for (const finding of uploadReport?.findings ?? []) {
      const id = finding.target.line_id
      if (!id || !edits) continue
      const patch = edits.patch[id] ?? {}
      const field = finding.target.field
      const touched =
        field === 'quantity' ? id in edits.qty
        : field === 'unit_price' ? id in edits.up
        : field === 'line_amount' ? id in edits.qty || id in edits.up
        : field === 'long_text' ? 'long' in patch
        : field === 'short_text' ? 'short' in patch
        : field === 'unit' ? 'unit' in patch
        : field === 'code' ? 'oz' in patch
        : false
      if (touched) out.add(finding.id)
    }
    return out
  }, [uploadReport, edits, isStale])
  const settled = useMemo(() => new Set([...reviewed, ...changedFindings]), [reviewed, changedFindings])
  const rowPoints = useMemo(() => {
    const points = new Map<string, number>()
    const positionIds = new Set(positions.map((position) => position.id))
    const add = (lineId: string | null | undefined, itemId: string) => {
      const value = risk?.points[itemId]
      if (!lineId || !value || settled.has(itemId)) return
      points.set(lineId, (points.get(lineId) ?? 0) + value)
    }
    for (const finding of uploadReport?.findings ?? []) {
      const id = finding.target.line_id
      add(id && positionIds.has(id) ? id : finding.related_line_ids.find((id) => positionIds.has(id)), finding.id)
    }
    for (const [id, signals] of signalsByRow) for (const signal of signals) add(id, signal.id)
    return points
  }, [uploadReport, positions, risk, settled, signalsByRow])
  // rows are memoized: reuse unchanged risk data across decisions
  const riskCacheRef = useRef(new Map<string, RowRisk>())
  const risks = useMemo(() => {
    const prev = riskCacheRef.current
    return new Map([...reviewByRow].flatMap(([id, items]) => {
      const open = items.filter((item) => !settled.has(item.id))
      if (!open.length) return []
      const severity = SEVERITIES.find((level) => open.some((item) => 'severity' in item && item.severity === level))
      const signalCount = open.filter((item) => !('severity' in item)).length
      const rowRisk: RowRisk = { severity, count: open.length - signalCount, signalCount, points: rowPoints.get(id) ?? 0, label: open.map((item) => item.title).join(', ') }
      const old = prev.get(id)
      return [[id, old && old.severity === rowRisk.severity && old.count === rowRisk.count && old.signalCount === rowRisk.signalCount && old.points === rowRisk.points && old.label === rowRisk.label ? old : rowRisk] as const]
    }))
  }, [reviewByRow, rowPoints, settled])
  useEffect(() => {
    riskCacheRef.current = risks
  }, [risks])
  const filterFindings = useMemo(() => [...reviewByRow.values()], [reviewByRow])
  // Keep findings in position order and fill the change-order slots in the assessment’s review order.
  const warningEntries = useMemo(() => {
    const seen = new Set<string>()
    const out: WarningEntry[] = []
    for (const position of positions) {
      for (const item of reviewByRow.get(position.id) ?? []) {
        if (seen.has(item.id)) continue
        seen.add(item.id)
        out.push({ item, position })
      }
    }
    for (const item of [...listWide, ...listSignals]) if (!seen.has(item.id)) out.push({ item, position: null })
    const ranks = new Map(risk?.change_order_signals.map((signal, index) => [signal.id, index]))
    const changes = out.filter(({ item }) => !('severity' in item))
      .sort((a, b) => (ranks.get(a.item.id) ?? Infinity) - (ranks.get(b.item.id) ?? Infinity))
    let nextChange = 0
    return out.map((entry) => 'severity' in entry.item ? entry : changes[nextChange++])
  }, [positions, reviewByRow, listWide, listSignals, risk])

  const [q, setQ] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<Set<string> | null>(null)
  const [ozFilter, setOzFilter] = useState<Set<string> | null>(null)
  const cats = grouped ? ozFilter : categoryFilter
  const setCats = grouped ? setOzFilter : setCategoryFilter
  const [sort, setSort] = useState<'oz' | 'amount' | 'risk'>('oz')
  const [positionFilter, setPositionFilter] = useState<PositionFilter | null>(null)
  const pricingFilter = positionFilter && 'pricing' in positionFilter ? positionFilter.pricing : null
  const researchShow = positionFilter && 'catalogue' in positionFilter ? positionFilter.catalogue : null
  const [selectMode, setSelectMode] = useState(false)
  const [sectionsOpen, setSectionsOpen] = useState(false)
  // the sticky total only appears once the hero total has scrolled away, so the number is never on screen twice
  const heroEnd = useRef<HTMLDivElement>(null)
  const [heroGone, setHeroGone] = useState(false)
  useEffect(() => {
    const el = heroEnd.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setHeroGone(!e.isIntersecting && e.boundingClientRect.top < 0))
    io.observe(el)
    return () => io.disconnect()
  }, [tab])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detailField, setDetailField] = useState<string | null>(null)
  const [findingFilter, setFindingFilter] = useState('all')
  const openDetail = (id: string | null, field: string | null = null) => {
    setDetailField(field)
    setDetailId(id)
  }
  const [adding, setAdding] = useState(false)
  const [addingSection, setAddingSection] = useState(false)
  const [showSections, setShowSections] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const [splitPre, setSplitPre] = useState<string[] | null>(null)
  const [splitMounted, setSplitMounted] = useState(false)
  const [movePids, setMovePids] = useState<string[] | null>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // "/" jumps to position search from anywhere on the page, as in most keyboard-first tools; "e" expands or collapses every section
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== '/' && e.key !== 'e') || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement
      if (t.closest('input,textarea,select,[contenteditable=true],[role=dialog],[role=menu]')) return
      e.preventDefault()
      if (e.key === 'e') setSectionsOpen((v) => !v)
      else searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const focusId = params.get('pos')

  useEffect(() => {
    useStore.getState().recordStats(doc.id, st)
  }, [doc.id, st])
  useEffect(() => {
    setSelected(new Set())
  }, [doc.id])

  const title = view?.title ?? doc.title
  const editedIds = useMemo(() => new Set([...Object.keys(edits?.qty ?? {}), ...Object.keys(edits?.up ?? {}), ...Object.keys(edits?.patch ?? {}), ...Object.keys(edits?.moves ?? {})]), [edits])
  const addedIds = useMemo(() => new Set((edits?.added ?? []).map((p) => p.id)), [edits])
  const modifiedIds = useMemo(() => new Set(positions
    .filter(p => editedIds.has(p.id) && !addedIds.has(p.id)).map(p => p.id)), [positions, editedIds, addedIds])
  const qtyEdited = useMemo(() => new Set(Object.keys(edits?.qty ?? {})), [edits])
  const upEdited = useMemo(() => new Set(Object.keys(edits?.up ?? {})), [edits])

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase()
    const matchesText = (p: Position) => p.oz.toLowerCase().includes(t) || p.short.toLowerCase().includes(t)
      || p.path?.some((part) => part.label.toLowerCase().includes(t))
    const originalMatches = grouped && t ? new Set(positions.filter(matchesText).map((p) => p.id)) : null
    const r = ledgerPositions.filter(p =>
      (!pricingFilter || matchesPricingFilter(pricingFilter, p, pending, modifiedIds)) &&
      (!researchShow || researchFilterOf(report?.positions[p.id]?.state) === researchShow) &&
      (!cats || cats.has(leafOz(p))) &&
      (!t || matchesText(p) || originalMatches?.has(p.id)) &&
      matchesFindingFilter(findingFilter, reviewByRow.get(p.id) ?? [], settled)
    )
    if (sort === 'amount') r.sort((a, b) => positionTotal(b) - positionTotal(a))
    if (sort === 'risk') r.sort((a, b) => (rowPoints.get(b.id) ?? 0) - (rowPoints.get(a.id) ?? 0))
    return r
  }, [positions, ledgerPositions, grouped, q, cats, sort, rowPoints, pricingFilter, researchShow, report, pending, modifiedIds, findingFilter, reviewByRow, settled])
  const repeatedIds = useMemo(() => {
    if (!findingFilter.startsWith('rule:')) return []
    const ids = new Set<string>()
    for (const row of rows) {
      for (const finding of findingsByRow.get(row.id) ?? []) {
        if (findingFilter === `rule:${finding.rule_id}` && !settled.has(finding.id)) ids.add(finding.id)
      }
    }
    return [...ids]
  }, [findingFilter, findingsByRow, rows, settled])

  const largest = useMemo(() => {
    let best: Position | null = null
    for (const p of positions) if (!best || positionTotal(p) > positionTotal(best)) best = p
    return best && positionTotal(best) > 0 ? { short: best.short, amount: positionTotal(best) } : null
  }, [positions])

  const detail = detailId ? positions.find((p) => p.id === detailId) ?? null : null
  const detailIdx = detailId ? rows.findIndex((r) => r.id === detailId) : -1
  const detailCatalogue = detail && report?.positions[detail.id]
  const catalogueDetails = detail && detailCatalogue && !(detail.up == null && pending.has(detail.id)) ? (
    <CatalogueDetails result={detailCatalogue} position={detail}
      onApply={(long) => useStore.getState().patchPosition(doc.id, detail.id, { long })} />
  ) : undefined
  const detailFindings = detail ? findingsByRow.get(detail.id) : undefined
  const detailItems = detail ? reviewByRow.get(detail.id) : undefined
  const detailOpen = detailItems?.filter((item) => !settled.has(item.id)).length ?? 0
  const detailExposure = detail && risk?.top_risks.find((row) => row.line_id === detail.id)?.amount
  // the next row (in table order, wrapping) that still has an open finding, so review can run row to row
  const nextFlagged = useMemo(() => {
    if (detailIdx < 0) return null
    for (let step = 1; step < rows.length; step++) {
      const row = rows[(detailIdx + step) % rows.length]
      if (reviewByRow.get(row.id)?.some((item) => !settled.has(item.id))) return row
    }
    return null
  }, [rows, detailIdx, reviewByRow, settled])
  // several findings often carry the same advice; say it once under the heading instead of under each
  const rationales = detailFindings?.map((finding) => finding.suggested_fix?.rationale ?? '') ?? []
  const sharedRationale = rationales.length > 1 && rationales[0] && rationales.every((note) => note === rationales[0]) ? rationales[0] : ''

  // screen readers hear the outcome, since the button they pressed changes its own label
  const [reviewNote, setReviewNote] = useState('')
  const decide = (ids: string[], decision: Decision | null, title?: string) => {
    const store = useStore.getState()
    if (isStale) return
    if (decision) {
      for (const id of ids) store.decideFindings(doc.id, [id], { ...decision, reviewKey: reviewKeys.get(id) })
    } else {
      store.decideFindings(doc.id, ids, null)
    }
    const what = !decision ? 'reopened' : decision.status === 'accepted' ? 'accepted' : 'dismissed'
    setReviewNote(`${title ?? plural(ids.length, 'item', 'items')}: ${what}`)
    if (ids.length > 1) toast(`${plural(ids.length, 'warning', 'warnings')} ${what}`, 'ok', { label: 'Undo', run: () => useStore.getState().decideFindings(doc.id, ids, null) })
  }
  const decideInDrawer = (findingId: string, title: string, decision: Decision | null) => {
    decide([findingId], decision, title)
    // after a decision, carry on with the next open finding in the drawer
    // when none is left on this row, the cursor waits on the way to the next flagged row
    if (decision) requestAnimationFrame(() => {
      const drawerFindings = document.getElementById('drawer-findings-h')?.parentElement
      const next = drawerFindings?.querySelector<HTMLElement>('[data-review="open"]')
        ?? drawerFindings?.querySelector<HTMLElement>('[data-next-finding]')
        ?? drawerFindings?.querySelector<HTMLElement>('#drawer-findings-h')
      next?.focus()
    })
  }
  // applies suggested fixes as tracked edits and records them as accepted; one Undo puts back edits and decisions
  const applyFixes = async (plans: { finding: Finding; plan: FixPlan }[]): Promise<boolean> => {
    if (!plans.length) return true
    if (!fixesAvailable || !uploadReport?.run_id) return false
    let latest: Assessment
    try {
      const response = await fetch(`/api/workspace/analysis?id=${encodeURIComponent(doc.id)}`, { cache: 'no-store' })
      if (!response.ok) throw new Error()
      latest = await response.json() as Assessment
    } catch {
      toast('Could not verify the current assessment.', 'error')
      return false
    }
    const store = useStore.getState()
    if (latest.report?.run_id !== uploadReport.run_id || !canApplyAssessmentFix(latest, store.edits[doc.id])) {
      toast('The assessment changed. Review the latest findings before applying a fix.', 'error')
      return false
    }
    plans = plans.filter(({ finding }) => finding.origin !== 'llm')
    if (!plans.length) return false
    const beforeEdits = store.edits[doc.id]
    const beforeDecisions = decisionsOf(store.listPatch[doc.id])
    const at = new Date().toISOString()
    for (const { plan } of plans) runSteps(store, doc.id, plan.steps)
    const findingDecisions = { ...beforeDecisions }
    for (const { finding } of plans) findingDecisions[finding.id] = { status: 'accepted', at, applied: at, reviewKey: finding.review_key }
    store.patchList(doc.id, { findingDecisions, reviewedFindings: Object.keys(findingDecisions) })
    const afterEdits = useStore.getState().edits[doc.id]
    const changes = plans.reduce((sum, { plan }) => sum + plan.steps.length, 0)
    setReviewNote(`${plural(plans.length, 'warning', 'warnings')} fixed`)
    toast(plans.length === 1 ? `Fixed: ${plans[0].finding.title}` : `Fixed ${plural(plans.length, 'warning', 'warnings')} with ${plural(changes, 'change', 'changes')}`, 'ok', {
      label: 'Undo',
      run: () => {
        const s = useStore.getState()
        if (s.edits[doc.id] !== afterEdits) {
          toast('The working list changed after those fixes were applied.', 'error')
          return
        }
        s.setEdits(doc.id, beforeEdits)
        s.patchList(doc.id, { findingDecisions: beforeDecisions, reviewedFindings: Object.keys(beforeDecisions) })
      },
    })
    return true
  }
  // web suggestions added to several long descriptions at once; Undo restores the edits from before
  const applySuggestions = (changes: { id: string; long: string }[]) => {
    if (!changes.length) return
    const before = useStore.getState().edits[doc.id]
    for (const { id, long } of changes) useStore.getState().patchPosition(doc.id, id, { long })
    toast(`Added ${plural(changes.length, 'web suggestion', 'web suggestions')} to the long descriptions`, 'ok', {
      label: 'Undo', run: () => useStore.getState().setEdits(doc.id, before),
    })
  }
  // a price typed for a position nothing could match: the same as typing it in the table
  const setOwnPrice = (id: string, price: number | null) => {
    const before = useStore.getState().edits[doc.id]?.up ?? {}
    const had = id in before
    const previous = before[id]
    useStore.getState().setUp(doc.id, id, price)
    const oz = positions.find((p) => p.id === id)?.oz
    toast(price == null ? `Cleared the price of ${oz}` : `Set ${money(price)} for position ${oz}`, 'ok', {
      label: 'Undo',
      run: () => {
        const e = useStore.getState().edits[doc.id]
        if (!e) return
        const up = { ...e.up }
        if (had) up[id] = previous
        else delete up[id]
        useStore.getState().setEdits(doc.id, { ...e, up })
      },
    })
  }
  const clearPositionFilters = () => {
    setPositionFilter(null)
    setQ('')
    setCategoryFilter(null)
    setOzFilter(null)
    setFindingFilter('all')
    setSelected(new Set())
  }
  const applyPositionFilter = (filter: PositionFilter | null) => {
    clearPositionFilters()
    setPositionFilter(filter)
    toTable()
  }
  const showWarnings = (filter: string) => {
    clearPositionFilters()
    setFindingFilter(filter)
    toTable()
  }
  const exportExcel = async () => {
    if (!uploadReport) return
    const data = await riskXlsx({ title, report: { ...uploadReport, outdated: isStale }, decisions, codes, questionTexts })
    downloadBytes(`Risikomatrix-${doc.fileName.replace(/\.[^.]+$/, '')}.xlsx`, data, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  }
  const printSections = useMemo(() => new Map(imported.positions.map((p) => [p.id, { oz: p.oz, section: p.path?.map((part) => `${part.oz} ${part.label}`).at(-1) ?? 'Without section' }])), [imported.positions])

  // the note is gone once a suggestion is settled: the cursor moves to the EP it filled (or left empty)
  const focusDrawerPrice = () => requestAnimationFrame(() => document.querySelector<HTMLElement>('[role=dialog] [data-risk-field="unit_price"]')?.focus())

  const removeSelected = () => {
    const ids = [...selected]
    useStore.getState().removePositions(doc.id, ids)
    setSelected(new Set())
    toast(`Removed ${plural(ids.length, 'position', 'positions')}`, 'ok', { label: 'Undo', run: () => useStore.getState().restorePositions(doc.id, ids) })
  }

  const split = () => {
    setSplitMounted(true)
    setSplitPre([...selected])
  }

  const addCategory = (parentOz: string | null, label: string) => {
    const oz = nextChildOz(tree, parentOz)
    useStore.getState().addCategory(doc.id, oz, label, parentOz)
    return oz
  }
  const renameCategory = (oz: string, label: string) => useStore.getState().renameCategory(doc.id, oz, label)

  const confirmMove = (targetOz: string) => {
    const pids = movePids ?? []
    const prev = useStore.getState().edits[doc.id]
    const r = applyMoves(positions, tree, pids.map((id) => [id, targetOz] as [string, string]))
    useStore.getState().movePositions(doc.id, pids, targetOz)
    setMovePids(null)
    const first = [...r.changes.values()][0]
    const label = indexTree(tree).node.get(targetOz)?.label ?? targetOz
    toast(`Moved ${plural(r.changes.size, 'position', 'positions')} to ${label}${first ? ` (${first.from} → ${first.to})` : ''}`, 'ok', {
      label: 'Undo',
      run: () => useStore.getState().setEdits(doc.id, prev),
    })
  }

  const toTable = () => setTimeout(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40)
  const review = () => {
    setSort('amount')
    setQ('')
    setCats(null)
    setFindingFilter('all')
    toTable()
  }
  const resetAll = () => {
    const prev = useStore.getState().edits[doc.id]
    const ids = [...modifiedIds]
    ids.forEach((x) => useStore.getState().resetPosition(doc.id, x))
    if (pricingFilter === 'edited') setPositionFilter(null)
    toast(`Reset ${plural(ids.length, 'position', 'positions')} to the imported values`, 'ok', { label: 'Undo', run: () => useStore.getState().setEdits(doc.id, prev) })
  }

  // confirming writes the suggested price as the position's own price, the same as typing it
  const confirmPrices = (ids: string[]) => {
    const picks = ids.flatMap((id) => {
      const s = pending.get(id)
      return s ? [[id, s] as [string, PriceSuggestion]] : []
    })
    if (!picks.length) return
    const before = useStore.getState().edits[doc.id]?.up ?? {}
    for (const [id, s] of picks) useStore.getState().setUp(doc.id, id, s.price)
    const oz = positions.find((p) => p.id === picks[0][0])?.oz
    // undo puts back only these prices, so edits made after confirming survive
    const undo = () => {
      const e = useStore.getState().edits[doc.id]
      if (!e) return
      const up = { ...e.up }
      for (const [id] of picks) {
        if (id in before) up[id] = before[id]
        else delete up[id]
      }
      useStore.getState().setEdits(doc.id, { ...e, up })
    }
    toast(picks.length === 1 ? `Confirmed ${money(picks[0][1].price)} for position ${oz}` : `Confirmed ${plural(picks.length, 'price', 'prices')}, ${money(picks.reduce((sum, [id, s]) => sum + s.price * (positions.find((p) => p.id === id)?.qty ?? 0), 0))} added`, 'ok', {
      label: 'Undo', run: undo,
    })
  }
  const dismissPrice = (id: string) => {
    const store = useStore.getState()
    const before = store.listPatch[doc.id]?.dismissedPrices ?? []
    store.patchList(doc.id, { dismissedPrices: [...new Set([...before, id])] })
    toast('Suggestion dismissed', 'ok', { label: 'Undo', run: () => useStore.getState().patchList(doc.id, { dismissedPrices: before }) })
  }

  const heading = title
  const pricingCounts = useMemo(() => {
    const counts: Record<PricingFilter, number> = { unpriced: 0, pending: 0, zero: 0, edited: 0 }
    for (const position of positions) {
      for (const filter of PRICING_FILTER_KEYS) {
        if (matchesPricingFilter(filter, position, pending, modifiedIds)) counts[filter]++
      }
    }
    return counts
  }, [positions, pending, modifiedIds])
  const { pending: pendingCount, edited: editedCount } = pricingCounts
  // what the pending suggestions would add; shown beside the total, never inside it
  const pendingTotal = positions.reduce((sum, p) => sum + (pending.get(p.id)?.price ?? 0) * p.qty, 0)
  // bulk confirm covers the rows on screen whose units are known; the rest are checked one by one in the drawer
  const confirmable = rows.filter((p) => p.up == null && pending.get(p.id)?.unitKnown).map((p) => p.id)
  const confirmableTotal = confirmable.reduce((sum, id) => sum + (pending.get(id)?.price ?? 0) * (positions.find((p) => p.id === id)?.qty ?? 0), 0)
  const filtered = !!q.trim() || !!cats || !!positionFilter || findingFilter !== 'all'
  const sections = pricingSections(tree, catStats)
  const live = view && !view.trashedAt ? view : null
  const more: (MenuItem | 'sep')[] = [
    { label: 'Add pricing section…', icon: 'playlist_add', onSelect: () => setAddingSection(true) },
    { label: 'Split into new list…', icon: 'call_split', onSelect: split },
    { label: 'Save corrected version', icon: 'content_copy', onSelect: () => {
      const id = 'l-' + crypto.randomUUID()
      const store = useStore.getState()
      store.addList({ ...doc, id, folderId: view?.folderId ?? doc.folderId, title: title + ' (korrigiert)', file: undefined, fileName: title + ' (korrigiert)', positions, tree, ...st, userCreated: true })
      store.patchList(id, { sourceListId: doc.id })
      toast('Saved corrected version', 'ok')
    } },
    { label: 'Rename list', icon: 'edit', onSelect: () => openDialog({ kind: 'rename-list', id: doc.id }) },
    ...(editedCount ? [{ label: 'Reset all edits', icon: 'restart_alt', onSelect: resetAll }] : []),
    ...(live ? [{ label: 'Move to another project…', icon: 'drive_file_move', onSelect: () => openDialog({ kind: 'folder-target', action: 'move-list', listId: doc.id }) }] : []),
    ...(attached.length
      ? (['sep' as const, ...[...attached].sort((a, b) => Number(b === original) - Number(a === original)).map((d) => ({ label: d === original ? `Original ${d.name.split('.').pop()?.toUpperCase() ?? 'file'}` : d.name, icon: d === original ? 'description' : 'attach_file', onSelect: () => openDialog({ kind: 'doc', doc: d }) }))] as (MenuItem | 'sep')[])
      : []),
    ...(uploadReport && risk ? [
      'sep' as const,
      { label: 'Excel risk matrix', icon: 'table_view', onSelect: () => void exportExcel() },
      { label: 'Print risk review / PDF', icon: 'print', onSelect: () => window.print() },
    ] : []),
    ...(live ? (['sep' as const, ...listMenu(live).filter((it) => it !== 'sep' && it.danger)] as (MenuItem | 'sep')[]) : []),
  ]

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'All Projects', to: '/' }, { label: folder?.name ?? 'Project', to: `/folder/${folder?.id ?? doc.folderId}` }]}
        title={heading}
        aside={
          <div className="flex items-center gap-2">
            <Button variant="primary" icon="add" onClick={() => setAdding(true)} aria-label="Add position" className="max-sm:w-10 max-sm:px-0">
              <span className="max-sm:hidden">Add position</span>
            </Button>
            {original && imported.phase === 'X83' && imported.source?.kind === 'gaeb-xml' && (
              <BidSimulator listId={doc.id} title={heading} standardRates={bidStandardRates} />
            )}
            <ExportMenu listId={doc.id} doc={doc} original={original} selectedIds={[...selected]} filteredIds={filtered ? rows.map((position) => position.id) : undefined} />
            <RowMenu items={more} label={`More actions for ${title}`} />
          </div>
        }
      />

      {view?.trashedAt && (
        <div className="mb-5 flex items-center justify-between gap-3 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="flex items-center gap-2"><Icon name="delete" size={18} />This list was deleted.</span>
          <button type="button" className="font-semibold underline underline-offset-4" onClick={() => useStore.getState().patchList(doc.id, { trashedAt: undefined })}>Restore</button>
        </div>
      )}

      {view?.supersededBy && (
        <div role="note" className="mb-5 flex items-start gap-2.5 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-700">
          <Icon name="info" size={18} className="mt-px text-slate-600" />
          <span>This is an earlier version. The {view.supersededBy} file of the same tender replaces it, so this list doesn't count toward project totals.</span>
        </div>
      )}

      <PhaseHeader
        total={st.total}
        phase={tab}
        onPhase={setTab}
        workflow={workflow}
        badges={{
          subcontractors: packages.length || null,
          x84: packages.filter((p) => p.chosenId).length || null,
        }}
        sub={pendingCount > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <Icon name="schedule" size={16} className="text-slate-500" />
            <span><span className="num font-medium text-slate-800">+ {money(pendingTotal)}</span> pending confirmation, not in the total</span>
          </span>
        )}
        // research sits in the status row under the meter, so every list hero has the same height
        note={catalogueEnabled && (
          <CatalogueOverview part="line" show={researchShow} setShow={filter => applyPositionFilter(filter ? { catalogue: filter } : null)} report={report} error={error} retryFailed={retryFailed} positions={positions} onOpen={openDetail} />
        )}
        extra={sections.length > 1 && showSections && (
          <div id="pricing-legend" aria-label="Pricing summary" role="region" className="mt-4 max-w-xl rounded-lg bg-slate-50 p-4">
            <PricingBreakdown sections={sections} className="max-w-md" />
            <PricingLegend sections={sections} />
          </div>
        )}
        meta={
          <div role="group" aria-label="Pricing position filters" className="flex flex-wrap items-center gap-x-1 gap-y-1">
            <span className="inline-flex w-[5.5rem] shrink-0 items-center gap-1.5 text-[13px] font-medium text-slate-500">
              <Icon name="sell" size={16} />Pricing
            </span>
            <MetaLink onClick={() => applyPositionFilter(null)} pressed={!filtered}>All <span className="num">{int(st.positionsCount)}</span> {st.positionsCount === 1 ? 'position' : 'positions'}</MetaLink>
            {PRICING_FILTER_KEYS.filter(filter => pricingCounts[filter] > 0 || pricingFilter === filter)
              .map(filter => (
                <MetaLink key={filter} pressed={pricingFilter === filter}
                  onClick={() => applyPositionFilter(pricingFilter === filter ? null : { pricing: filter })}>
                  <span className="num">{int(pricingCounts[filter])}</span> {PRICING_FILTERS[filter].toLowerCase()}
                </MetaLink>
              ))}
            {(sections.length > 1 || largest) && (
              <span className="flex items-center gap-1 sm:ml-auto">
                {sections.length > 1 && (
                  <button type="button" aria-expanded={showSections} aria-controls="pricing-legend" onClick={() => setShowSections((v) => !v)} className="inline-flex h-8 items-center gap-1 rounded-md px-2.5 font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900 aria-expanded:bg-slate-100 aria-expanded:text-slate-900">
                    <Icon name="donut_small" size={16} className="text-slate-500" />Cost by section<Icon name="expand_more" size={18} className={clsx('text-slate-500 transition-transform', showSections && 'rotate-180')} />
                  </button>
                )}
                {largest && (
                  <button type="button" onClick={review} className="inline-flex h-8 items-center gap-1 rounded-md px-2.5 font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900">
                    <Icon name="trending_up" size={16} className="text-slate-500" />Review the biggest positions
                  </button>
                )}
              </span>
            )}
          </div>
        }
      >
      {tab === 'x83' && <PhasePanel phase="x83">
      {comparableCap && <p role="status" className="mb-4 text-sm font-medium text-slate-800">
        {budgetStatus(Number(comparableCap.working_net), Number(comparableCap.cap)).word}
        {' · Working net '}{budgetMoney(Number(comparableCap.working_net), comparableCap.currency)}
        {' · Recorded cap '}{budgetMoney(Number(comparableCap.cap), comparableCap.currency)}
      </p>}
      {cap && 'reason' in cap && <p role="note" className="mb-4 text-sm text-slate-600">{cap.reason}</p>}
      {uploadReport && (
        <WarningsPanel entries={warningEntries} decisions={decisions} settled={settled} positions={positions} allowFixes={fixesAvailable}
          title={title} questionsByFinding={questionsByFinding} onOpen={(id) => openDetail(id, 'findings')} onFilter={showWarnings}
          onDecide={decide} onApplyFixes={applyFixes} />
      )}

      {optimizations.length > 0 && (
        <details className="mb-5 max-w-4xl rounded-lg bg-slate-50 p-4">
          <summary className="cursor-pointer font-medium">Optimization suggestions ({optimizations.length})</summary>
          <ul className="mt-2 space-y-2 text-sm text-slate-700">
            {optimizations.map(finding => <li key={finding.id}><strong>{finding.title}</strong> · {finding.message}</li>)}
          </ul>
        </details>
      )}

      <div ref={heroEnd} aria-hidden />
      <div ref={tableRef} className="scroll-mt-20">
        {catalogueEnabled && researchShow && (
          <div className="mb-6">
            <CatalogueOverview part="list" show={researchShow} setShow={filter => applyPositionFilter(filter ? { catalogue: filter } : null)} report={report} error={error} retryFailed={retryFailed} positions={rows}
              onOpen={(id) => openDetail(id, researchShow === 'suggested' ? 'web_suggestion' : undefined)}
              onApplyAll={applySuggestions} onPrice={setOwnPrice} />
          </div>
        )}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-auto sm:min-w-56 sm:flex-1 lg:max-w-sm">
            <Icon name="search" size={20} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-slate-600" />
            <input
              ref={searchRef}
              data-results-heading
              type="search"
              aria-label="Search positions"
              aria-keyshortcuts="/"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search positions"
              className="peer h-10 w-full rounded-md bg-white pr-10 pl-11 text-sm text-slate-900 shadow-[0_1px_0_var(--color-slate-200)] ring-1 ring-slate-300 transition-[background-color,box-shadow] outline-none ring-inset placeholder:text-slate-600 hover:ring-slate-400 focus:ring-2 focus:ring-brand-700"
            />
            {!q && <kbd aria-hidden className={clsx(kbdCls, 'pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 peer-focus:hidden [@media(hover:none)]:hidden')}>/</kbd>}
          </div>
          {ozGroups && (
            <label className={pillCls(false)}>
              Group by
              <select className="bg-transparent font-semibold" value={grouping} onChange={(e) => {
                setGrouping(e.target.value === 'oz' ? 'oz' : 'category')
                setSort('oz')
              }}>
                <option value="category">Category</option>
                <option value="oz">Position number (OZ)</option>
              </select>
            </label>
          )}
          <CategoryFilter key={ledgerGrouping} tree={ledgerTree} stats={ledgerStats} value={cats} onChange={setCats} byOz={!!grouped} />
          <FindingFilter rows={filterFindings} reviewed={settled} value={findingFilter} onChange={setFindingFilter} />
          {repeatedIds.length > 1 && (
            <DismissMenu label={`Dismiss ${repeatedIds.length} shown warnings`} onDismiss={(decision) => decide(repeatedIds, decision)}>
              {`Dismiss ${repeatedIds.length} shown warnings`}
            </DismissMenu>
          )}
          {assessment?.state === 'waiting' && (
            <span role="status" className="inline-flex h-10 items-center gap-1.5 text-sm text-slate-600">
              <Icon name="progress_activity" size={18} className="animate-spin" />Checking the uploaded list
            </span>
          )}
          {(assessment?.state === 'failed' || assessment?.state === 'unavailable') && (
            <span role="status" className="inline-flex h-10 items-center gap-1.5 text-sm text-amber-900">
              <Icon name="error" size={18} />Upload check unavailable
            </span>
          )}
          {(pricingFilter || researchShow) && (
            <FilterPill on onClick={() => setPositionFilter(null)}>
              {pricingFilter ? PRICING_FILTERS[pricingFilter] : researchShow && CATALOGUE_FILTERS[researchShow]}
              <span className="num">{int(rows.length)}</span>
            </FilterPill>
          )}
          {pricingFilter === 'pending' && confirmable.length > 0 && (
            <button type="button" onClick={() => confirmPrices(confirmable)} title={`Adds ${money(confirmableTotal)}: the list total becomes ${money(st.total + confirmableTotal)}`} aria-label={`Confirm ${plural(confirmable.length, 'shown price', 'shown prices')}, adds ${money(confirmableTotal)}; the list total becomes ${money(st.total + confirmableTotal)}`} className="inline-flex h-10 items-center gap-1.5 rounded-md px-3 text-sm font-semibold text-slate-800 hover:bg-slate-100">
              <Icon name="done_all" size={18} />Confirm {plural(confirmable.length, 'price', 'prices')}
              <span className="num font-medium text-slate-600">+{money(confirmableTotal)}</span>
            </button>
          )}
          {pricingFilter === 'edited' && editedCount > 0 && (
            <button type="button" onClick={resetAll} className="h-10 rounded-md px-3 text-sm font-semibold text-slate-800 hover:bg-slate-100">Reset all</button>
          )}
          {filtered && <Button size="sm" variant="ghost" onClick={clearPositionFilters}>Clear filters</Button>}
          <div className="flex items-center gap-2 sm:ml-auto">
            <button
              type="button"
              aria-pressed={selectMode || selected.size > 0}
              title="Select positions"
              onClick={() => { if (selectMode) setSelected(new Set()); setSelectMode((v) => !v) }}
              className={pillCls(selectMode || selected.size > 0)}
            >
              <Icon name="checklist" size={18} /><span className="max-[1399px]:sr-only">Select</span>
            </button>
            {sort === 'oz' && !filtered && ledgerTree.length > 0 && (
              <ToolButton icon={sectionsOpen ? 'unfold_less' : 'unfold_more'} aria-expanded={sectionsOpen} aria-keyshortcuts="e" title={`${sectionsOpen ? 'Collapse' : 'Expand'} all sections (E)`} onClick={() => setSectionsOpen((v) => !v)} className="max-[1399px]:w-10 max-[1399px]:justify-center max-[1399px]:px-0">
                <span className="max-[1399px]:sr-only">{sectionsOpen ? 'Collapse all' : 'Expand all'}</span>
              </ToolButton>
            )}
            {risk
              ? <SortMenu value={sort} options={{ oz: 'Position order', amount: 'Highest amount', risk: 'Highest risk' }} onChange={setSort} noun="positions" />
              : <SortMenu value={sort === 'amount' ? 'amount' : 'oz'} options={{ oz: 'Position order', amount: 'Highest amount' }} onChange={setSort} noun="positions" />}
          </div>
        </div>

        <LedgerTable
          key={ledgerGrouping}
          listId={doc.id}
          rows={rows}
          tree={ledgerTree}
          byOz={!!grouped}
          showEmpty={!filtered}
          selected={selected}
          setSelected={setSelected}
          focusId={focusId}
          onOpen={(position, field) => openDetail(position.id, field)}
          onMove={(pid) => setMovePids([pid])}
          editedIds={editedIds}
          qtyEdited={qtyEdited}
          upEdited={upEdited}
          risks={risks}
          pending={pending}
          catalogue={report?.positions}
          onConfirmPrice={(pid) => confirmPrices([pid])}
          sectionsOpen={sectionsOpen}
          sortActive={sort !== 'oz'}
          selectMode={selectMode}
        />

        {/* sticky footer: the running total, or the batch actions while rows are selected */}
        <div className={clsx('sticky bottom-0 z-20 -mx-4 mt-2 border-t border-slate-200 bg-white px-4 py-3 transition-opacity sm:-mx-8 sm:px-8', !(heroGone || selected.size > 0 || rows.length !== positions.length) && 'pointer-events-none opacity-0')} aria-hidden={!(heroGone || selected.size > 0 || rows.length !== positions.length) || undefined}>
          {selected.size > 0 ? (
            <div role="toolbar" aria-label="Selected positions" className="flex flex-wrap items-center gap-1 text-sm">
              <span className="mr-2 font-semibold text-slate-900" aria-live="polite">{plural(selected.size, 'position', 'positions')} selected</span>
              <button type="button" onClick={() => setMovePids([...selected])} className="inline-flex h-10 items-center gap-1.5 rounded-md px-3 font-medium text-slate-800 hover:bg-slate-100">
                <Icon name="drive_file_move" size={18} />Move
              </button>
              <button type="button" onClick={split} className="inline-flex h-10 items-center gap-1.5 rounded-md px-3 font-medium text-slate-800 hover:bg-slate-100">
                <Icon name="call_split" size={18} />Split into new list
              </button>
              <button type="button" onClick={removeSelected} className="inline-flex h-10 items-center gap-1.5 rounded-md px-3 font-medium text-rose-700 hover:bg-rose-50">
                <Icon name="delete" size={18} />Remove
              </button>
              <button type="button" onClick={() => { setSelected(new Set()); setSelectMode(false) }} className={clsx('ml-auto inline-flex h-10 items-center rounded-md px-4 font-semibold', raisedCls)}>Clear</button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm text-slate-600">
              <span className="flex items-center gap-3">
                <button
                  type="button"
                  aria-label="Search positions"
                  onClick={() => { tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); searchRef.current?.focus({ preventScroll: true }) }}
                  className={clsx('inline-flex h-10 w-10 items-center justify-center rounded-md', raisedCls)}
                >
                  <Icon name="search" size={20} />
                </button>
                <span className={rows.length === positions.length ? 'max-sm:hidden' : undefined}>
                  {rows.length !== positions.length
                    ? <><span className="num font-semibold text-slate-900">{int(rows.length)}</span> of <span className="num">{int(positions.length)}</span> positions shown</>
                    : <span className="num">{plural(positions.length, 'position', 'positions')}</span>}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>List total</span>
                <span className="num text-base font-semibold text-slate-900">{money(st.total)}</span>
              </span>
            </div>
          )}
        </div>
      </div>

      {(assessment || listWide.length > 0 || listSignals.length > 0 || uploadReport?.source_notice || analysisErrors.length > 0) && (
        <section aria-labelledby="list-findings-h" className="mt-8">
          <h2 id="list-findings-h" className="font-heading text-base font-bold text-slate-900">Warnings for the whole list</h2>
          {(assessment || uploadReport?.source_notice || analysisErrors.length > 0) && (
            <div className="mt-1 space-y-1 text-sm text-amber-900" role="note">
              {isStale && <p>Previous assessment. Waiting for results for the working revision.</p>}
              {assessment?.state === 'waiting' && <p>Assessment queued.</p>}
              {assessment?.state === 'failed' && <p>Assessment failed after retrying.</p>}
              {assessment?.state === 'unavailable' && <p>Assessment is currently unavailable.</p>}
              {uploadReport?.graph_valid === false && <p>Invalid references prevent some checks and disable assessment fixes.</p>}
              {uploadReport?.source_notice && <p>{uploadReport.source_notice}</p>}
              {analysisErrors.slice(0, 3).map((error, index) => <p key={index}>{error}</p>)}
            </div>
          )}
          {(listWide.length > 0 || listSignals.length > 0) && (
            <ul className="mt-3 space-y-4">
              {[...listWide, ...listSignals].map((item) => (
                <li key={item.id} className="space-y-3">
                  {'severity' in item ? <FindingText finding={item} decision={decisions[item.id]} details />
                    : <ChangeOrderText signal={item} decision={decisions[item.id]} />}
                  <FindingQuestions title={title} questions={questionsByFinding.get(item.id)} />
                  <DecisionControls className="ml-[15px]" title={item.title} decision={decisions[item.id]}
                    onDecide={(decision) => decide([item.id], decision, item.title)} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {doc.notes && (
        <section className="mt-8 rounded-lg bg-slate-50">
          <button
            type="button"
            aria-expanded={notesOpen}
            onClick={() => setNotesOpen((o) => !o)}
            className="flex w-full items-center justify-between gap-2 rounded-lg px-5 py-4 text-left text-[15px] font-semibold text-slate-900"
          >
            <span className="flex items-center gap-2.5"><Icon name="notes" size={20} className="text-slate-500" />Vorbemerkungen</span>
            <Icon name="expand_more" size={20} className={clsx('text-slate-500 transition-transform', notesOpen && 'rotate-180')} />
          </button>
          <AnimatePresence initial={false}>
            {notesOpen && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }} className="overflow-hidden">
                <div className="max-h-96 overflow-y-auto px-5 pb-5 text-sm leading-relaxed whitespace-pre-line text-slate-700">{doc.notes}</div>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      )}
      </PhasePanel>}

      {/* print output must work from every tab */}
      {uploadReport && risk && (
        <RiskPrint title={title} report={{ ...uploadReport, outdated: isStale }} risk={risk} decisions={decisions} sections={printSections} questions={questions} texts={questionTexts} />
      )}

      {tab === 'subcontractors' && (
        <PhasePanel phase="subcontractors">
          <SubcontractorsTab listId={doc.id} doc={doc} resolved={resolved} packages={packages} demoIds={demoIds} demoNames={workflowDemo?.demoNames} positions={positions} onNew={() => setSending(true)} />
        </PhasePanel>
      )}
      {tab === 'x84' && (
        <PhasePanel phase="x84">
          <OfferTab
            listId={doc.id}
            doc={doc}
            tree={tree}
            packages={packages}
            demoNames={workflowDemo?.demoNames}
            positions={positions}
            pending={pending}
            onSubcontractors={() => setTab('subcontractors')}
            onReviewAi={() => { setTab('x83'); applyPositionFilter({ pricing: 'pending' }) }}
          />
        </PhasePanel>
      )}
      {tab === 'x86' && (
        <PhasePanel phase="x86">
            {phase?.state === 'verified' && <p role="status">Phase link verified for {phase.matched_positions} positions.</p>}
            {phase?.reason && <p role="note">{phase.reason}</p>}
          <AwardTab listId={doc.id} award={award} onOpen={(d) => openDialog({ kind: 'doc', doc: d })} />
        </PhasePanel>
      )}
      </PhaseHeader>

      <SubcontractOverlay open={sending} onClose={() => setSending(false)} listId={doc.id} doc={doc} resolved={resolved} selectedIds={[...selected]} />

      <AddSectionDialog open={addingSection} onClose={() => setAddingSection(false)} onAdd={(name) => {
        addCategory(null, name)
        clearPositionFilters()
        setSort('oz')
        toast(`Added section "${name}"`)
      }} />
      <AddItemDialog open={adding} onClose={() => setAdding(false)} listId={doc.id} tree={tree} positions={positions} />
      <DetailDrawer
        p={detail}
        pendingPrice={detail && detail.up == null ? pending.get(detail.id)?.price ?? null : null}
        suggestion={detail && detail.up == null && pending.get(detail.id) ? (
          <PriceSuggestionNote key={detail.id} s={pending.get(detail.id)!} unit={detail.unit}
            onConfirm={() => { confirmPrices([detail.id]); focusDrawerPrice() }} onDismiss={() => { dismissPrice(detail.id); focusDrawerPrice() }} />
        ) : undefined}
        webSuggestion={detailCatalogue?.suggestion ? catalogueDetails : undefined}
        catalogue={detailCatalogue?.suggestion ? undefined : catalogueDetails}
        findings={detailItems?.length ? (
          <section aria-labelledby="drawer-findings-h">
            <h3 id="drawer-findings-h" tabIndex={-1} data-risk-field="findings" className="rounded text-[15px] font-semibold text-slate-900">
              Upload check
              <span className="num ml-2 text-sm font-medium text-slate-600">{detailOpen ? `${int(detailOpen)} to review` : 'All reviewed'}</span>
            </h3>
            {detailExposure != null && Number.isFinite(Number(detailExposure)) && (
              <p className="mt-1 text-sm text-slate-600">Money at stake <strong>{money(Number(detailExposure))}</strong></p>
            )}
            {sharedRationale && (
              <details className="group/why mt-1 text-sm text-slate-600">
                <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded font-medium text-slate-700 hover:text-slate-900 [&::-webkit-details-marker]:hidden">
                  <Icon name="chevron_right" size={18} className="transition-transform group-open/why:rotate-90" />
                  Why these were flagged
                </summary>
                <p className="mt-1 mb-2 max-w-[60ch] leading-relaxed text-pretty">{sharedRationale}</p>
              </details>
            )}
            <ul className="mt-3 space-y-5">
              {detailItems.map((item) => (
                <li key={item.id} className="space-y-3">
                  {'severity' in item
                    ? <FindingText finding={item} decision={decisions[item.id]} changed={changedFindings.has(item.id)} hideRationale={!!sharedRationale} details />
                    : <ChangeOrderText signal={item} decision={decisions[item.id]} />}
                  <FindingQuestions title={title} questions={questionsByFinding.get(item.id)} />
                  <DecisionControls className="ml-[15px]" title={item.title} decision={decisions[item.id]}
                    onDecide={(decision) => decideInDrawer(item.id, item.title, decision)} />
                </li>
              ))}
            </ul>
            <p className="sr-only" aria-live="polite">{reviewNote}</p>
            {nextFlagged && (
              <button type="button" data-next-finding onClick={() => openDetail(nextFlagged.id, 'findings')}
                className="group/next mt-5 flex min-h-9 max-w-full items-start gap-1.5 rounded py-1 text-left text-sm text-slate-700 hover:text-slate-900">
                <Icon name="arrow_downward" size={16} className="mt-0.5 shrink-0" />
                <span className="min-w-0">
                  <span className="block font-semibold underline decoration-slate-400 underline-offset-4 group-hover/next:decoration-slate-700">Next position to review</span>
                  <span className="block text-pretty text-slate-600"><span className="num mr-1.5 font-mono text-[13px]">{nextFlagged.oz}</span><span lang="de" className="hyphens-auto">{nextFlagged.short}</span></span>
                </span>
              </button>
            )}
          </section>
        ) : undefined}
        focusField={detailField}
        onClose={() => setDetailId(null)}
        edited={!!detail && editedIds.has(detail.id)}
        added={!!detail && addedIds.has(detail.id)}
        imported={detail ? doc.positions.find((x) => x.id === detail.id) ?? null : null}
        onPatch={(patch) => detail && useStore.getState().patchPosition(doc.id, detail.id, patch)}
        onCode={(code) => {
          if (!detail || code === detail.oz) return true
          if (!code || positions.some((position) => position.id !== detail.id && position.oz === code)) {
            toast(code ? 'That OZ is already in use' : 'Enter a position number', 'error')
            return false
          }
          useStore.getState().patchPosition(doc.id, detail.id, { oz: code })
          return true
        }}
        onQty={(n) => detail && useStore.getState().setQty(doc.id, detail.id, n)}
        onUp={(n) => detail && useStore.getState().setUp(doc.id, detail.id, n)}
        onReset={() => detail && useStore.getState().resetPosition(doc.id, detail.id)}
        onMoveCategory={() => detail && setMovePids([detail.id])}
        onRemove={() => {
          if (!detail) return
          const id = detail.id
          const next = rows[detailIdx + 1]?.id ?? rows[detailIdx - 1]?.id ?? null
          useStore.getState().removePositions(doc.id, [id])
          openDetail(next)
          toast('Removed 1 position', 'ok', { label: 'Undo', run: () => useStore.getState().restorePositions(doc.id, [id]) })
        }}
        position={detailIdx >= 0 ? `${detailIdx + 1} of ${rows.length}` : undefined}
        listTotal={st.total}
        onPrev={detailIdx > 0 ? () => openDetail(rows[detailIdx - 1].id) : undefined}
        onNext={detailIdx >= 0 && detailIdx < rows.length - 1 ? () => openDetail(rows[detailIdx + 1].id) : undefined}
      />
      <MoveToCategory
        open={!!movePids}
        onClose={() => setMovePids(null)}
        tree={tree}
        positions={positions}
        pids={movePids ?? []}
        onAddCategory={addCategory}
        onRename={renameCategory}
        onConfirm={confirmMove}
      />
      {splitMounted && (
        <Suspense fallback={null}>
          <SplitOverlay
            open={splitPre !== null}
            onClose={() => setSplitPre(null)}
            doc={doc}
            title={title}
            positions={positions}
            tree={tree}
            folders={folders.filter((f) => !f.trashedAt).map((f) => ({ id: f.id, name: f.name }))}
            folderId={view?.folderId ?? doc.folderId}
            preselected={splitPre ?? []}
            onAddCategory={addCategory}
            onRenameCategory={renameCategory}
          />
        </Suspense>
      )}
    </>
  )
}

const BASIS: Record<string, string> = { supplier_quote: 'supplier quote', tender_offer: 'earlier tender offer' }

/** the drawer's pending-price note: where the number comes from, and the two ways to settle it */
function PriceSuggestionNote({ s, unit, onConfirm, onDismiss }: { s: PriceSuggestion; unit: string; onConfirm: () => void; onDismiss: () => void }) {
  const [unitOk, setUnitOk] = useState(false)
  const source = [s.product.supplier, s.basis ? BASIS[s.basis] : null, s.validFrom ? `from ${new Date(s.validFrom).toLocaleDateString('de-DE')}` : null].filter(Boolean).join(', ')
  return (
    <div role="group" aria-label="Suggested unit price" className="rounded-lg border border-dashed border-slate-400 bg-slate-50 p-4">
      <p className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-900"><Icon name="schedule" size={18} className="text-slate-600" />Pending confirmation</span>
        <span className="num text-[15px] font-semibold text-slate-900">{money(s.price)}<span className="font-normal text-slate-600">{(unit || s.unit) && ` / ${unit || s.unit}`}</span></span>
      </p>
      <p className="mt-1 text-sm leading-relaxed text-slate-700">
        From the catalogue match <span lang="de" className="font-medium">{s.product.name}</span>{source && <> ({source})</>}.
      </p>
      {!s.unitKnown && (
        // one side names no unit: show both, and ask for a deliberate yes before the price can count
        <div className="mt-3 space-y-2">
          <dl className="grid grid-cols-2 gap-x-4 text-sm">
            <div>
              <dt className="text-[13px] text-slate-600">Catalogue unit</dt>
              <dd className={s.unit ? 'font-medium text-slate-900' : 'text-slate-600 italic'}>{s.unit || 'none given'}</dd>
            </div>
            <div>
              <dt className="text-[13px] text-slate-600">Position unit</dt>
              <dd className={unit ? 'font-medium text-slate-900' : 'text-slate-600 italic'}>{unit || 'none given'}</dd>
            </div>
          </dl>
          <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm font-medium text-slate-800">
            <input type="checkbox" className="checkbox" checked={unitOk} onChange={(e) => setUnitOk(e.target.checked)} />
            The price is per {s.unit || unit || 'unit'} for this position
          </label>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" icon="check" onClick={onConfirm} disabled={!s.unitKnown && !unitOk}>Confirm price</Button>
        <Button onClick={onDismiss}>Dismiss</Button>
      </div>
    </div>
  )
}
