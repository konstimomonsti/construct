import { Row, RowList, RowMenu, BudgetMini, budgetPhrase } from './Kit'
import { money, plural } from '../lib/format'
import { useActions } from '../lib/actions'
import type { ListView } from '../lib/store'

/** when several lists share a title, lead with the file name so they can be told apart */
export function listLabel(l: ListView, siblings: ListView[]) {
  const dup = siblings.filter((x) => x.title === l.title).length > 1
  return dup ? { title: l.fileName, sub: l.title } : { title: l.title, sub: l.fileName }
}

/** "Award · D86" or "Bid · D84 · not counted" */
export function phaseLabel(l: ListView) {
  if (!l.phaseCode) return null
  return [l.phaseName, l.phaseCode, l.supersededBy ? 'not counted' : null].filter(Boolean).join(' · ')
}

export function ListRow({ list: l, siblings = [], tone = 'indigo' }: { list: ListView; siblings?: ListView[]; tone?: string }) {
  const { listMenu } = useActions()
  const { title, sub } = listLabel(l, siblings)
  const unpriced = l.positionsCount - l.pricedCount
  const phase = phaseLabel(l)
  const subtitle = [
    phase ?? (sub !== title ? sub : null),
    plural(l.positionsCount, 'position', 'positions'),
    unpriced > 0 && l.total > 0 ? `${unpriced} to price` : null,
  ].filter(Boolean).join(' · ')
  return (
    <Row
      dataRow="list"
      to={`/list/${l.id}`}
      label={`${title}, ${plural(l.positionsCount, 'position', 'positions')}, ${money(l.total)}, ${l.supersededBy ? 'earlier version, not counted' : budgetPhrase(l.total, l.cap)}`}
      icon="request_quote"
      tone={l.supersededBy ? 'slate' : tone}
      title={title}
      subtitle={subtitle}
      amount={<span className={l.supersededBy ? 'text-slate-500 line-through decoration-slate-500' : undefined}>{money(l.total)}</span>}
      meta={l.supersededBy ? <span className="text-sm text-slate-600">Replaced by {l.supersededBy}</span> : <BudgetMini total={l.total} cap={l.cap} label={`${title} budget used`} />}
      menu={<RowMenu items={listMenu(l)} label={`Options for ${title}`} />}
    />
  )
}

export function ListGrid({ lists, tone }: { lists: ListView[]; tone?: string }) {
  return (
    <RowList>
      {lists.map((l) => (
        <ListRow key={l.id} list={l} siblings={lists} tone={tone} />
      ))}
    </RowList>
  )
}
