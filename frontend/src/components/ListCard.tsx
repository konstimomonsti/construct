import { Row, RowList, RowMenu, BudgetBadge, BudgetMini, budgetPhrase } from './Kit'
import { int, money, moneyWhole, plural } from '../lib/format'
import { useActions } from '../lib/actions'
import type { ListView } from '../lib/store'

/** when several lists share a title, lead with the file name so they can be told apart */
export function listLabel(l: ListView, siblings: ListView[]) {
  const dup = siblings.filter((x) => x.title === l.title).length > 1
  return dup ? { title: l.fileName, sub: l.title } : { title: l.title, sub: l.fileName }
}

const SOURCES: Record<string, string> = {
  pdf: 'PDF import', doc: 'Word import', docx: 'Word import', xls: 'Excel import', xlsx: 'Excel import',
  csv: 'CSV import', tsv: 'CSV import', json: 'JSON import',
}

/** "Award" for GAEB lists, "Word import" otherwise, so every row's subtitle reads the same way */
export function phaseLabel(l: ListView) {
  if (l.phaseName) return [l.phaseName, l.supersededBy ? 'not counted' : null].filter(Boolean).join(' · ')
  const ext = l.fileName.split('.').pop()?.toLowerCase() ?? ''
  if (/^[dpx]8\d$/.test(ext) || ext === 'xml') return 'GAEB import'
  return SOURCES[ext] ?? (l.fileName ? 'Import' : 'Blank list')
}

/** only the exception ("12 not priced", "no positions yet"); a fully priced list says nothing */
export function completeness(l: ListView) {
  const unpriced = l.positionsCount - l.pricedCount
  if (!l.positionsCount) return 'no positions yet'
  if (unpriced > 0) return `${int(unpriced)} not priced`
  return ''
}

/** display-only: a list title that repeats its project ("RINGSCHLUSS …, Projekt") is shortened to the part that differs */
export function displayTitle(title: string, project?: string) {
  let t = title.trim()
  if (project && t.toLowerCase().startsWith(project.toLowerCase()) && t.length > project.length + 3) {
    t = t.slice(project.length).replace(/^[\s,–\-:·]+/, '')
  }
  if (t.length > 8 && t === t.toUpperCase() && /[A-ZÄÖÜ]{4}/.test(t)) {
    // title-case word by word; codes and placeholders ("[PERSON_132]", "D86", "BA2") stay verbatim
    t = t.split(/(\s+|[-/(])/).map((w) => (/[\d_[\]]/.test(w) || w.length < 2 ? w : w.charAt(0) + w.slice(1).toLowerCase())).join('')
  }
  return t
}

/** pricing coverage read from confirmed position counts, so a saved zero price counts as priced */
function listPricing(l: ListView) {
  const blank = !l.positionsCount
  const priced = l.pricedCount > 0 || l.total > 0
  const coverage = blank ? 'no positions yet' : `${int(l.pricedCount)} of ${plural(l.positionsCount, 'position', 'positions')} priced`
  return { blank, priced, coverage }
}

export function ListRow({
  list: l, siblings = [], tone = 'indigo', selectMode, selected, onToggle,
}: { list: ListView; siblings?: ListView[]; tone?: string; selectMode?: boolean; selected?: boolean; onToggle?: () => void }) {
  const { listMenu } = useActions()
  const { title } = listLabel(l, siblings)
  const { blank, priced, coverage } = listPricing(l)
  const subtitle = [phaseLabel(l), blank ? null : plural(l.positionsCount, 'position', 'positions'), priced ? completeness(l) : null].filter(Boolean).join(' · ')
  // the link names the cap and how much is priced, also for a list whose prices were saved as zero
  const capPhrase = l.cap ? `cap ${moneyWhole(l.cap)}` : 'no cap set'
  const label = [
    title, phaseLabel(l), coverage,
    priced ? money(l.total) : blank ? null : 'not priced',
    l.supersededBy ? 'earlier version, not counted' : priced && l.cap ? `${budgetPhrase(l.total, l.cap, true)} of ${moneyWhole(l.cap)}` : capPhrase,
  ].filter(Boolean).join(', ')
  const meta = l.supersededBy
    ? <span className="text-sm text-slate-600">Replaced by {l.supersededBy}</span>
    : blank ? <span className="text-sm text-slate-600">No positions yet</span>
    : priced ? <BudgetMini total={l.total} cap={l.cap} priced label={`${title} budget used`} />
    : <span className="text-sm text-slate-600">Not priced</span>
  return (
    <Row
      dataRow="list"
      to={`/list/${l.id}`}
      label={label}
      icon="request_quote"
      tone={l.supersededBy ? 'slate' : tone}
      title={title}
      badge={l.supersededBy ? undefined : <BudgetBadge total={l.total} cap={l.cap} />}
      subtitle={subtitle}
      amount={priced || l.supersededBy ? <span className={l.supersededBy ? 'text-slate-500 line-through decoration-slate-500' : undefined}>{money(l.total)}</span> : undefined}
      meta={meta}
      menu={<RowMenu items={listMenu(l)} label={`Options for ${title}`} />}
      selectMode={selectMode}
      selected={selected}
      onToggle={onToggle}
    />
  )
}

export function ListGrid({
  lists, tone, selectMode, selected, onToggle,
}: { lists: ListView[]; tone?: string; selectMode?: boolean; selected?: Set<string>; onToggle?: (id: string) => void }) {
  return (
    <RowList>
      {lists.map((l) => (
        <ListRow key={l.id} list={l} siblings={lists} tone={tone} selectMode={selectMode} selected={selected?.has(l.id)} onToggle={() => onToggle?.(l.id)} />
      ))}
    </RowList>
  )
}
