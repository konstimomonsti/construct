import { useMemo, useState } from 'react'
import { BudgetBadge, BudgetMini, Chips, EmptyState, PageFrame, PageHeader, Row, RowList, RowMenu, Section, SortMenu, Summary, ToolButton, budgetPhrase, heroStatus } from '../components/Kit'
import { Dock } from '../components/Dock'
import { counts, useModel, type ListView } from '../lib/store'
import { budgetStatus, money, needsAttention, plural } from '../lib/format'
import { useActions } from '../lib/actions'
import { completeness, displayTitle, listLabel, phaseLabel } from '../components/ListCard'

type Key = 'total' | 'usage' | 'title' | 'folder'
const SORTS: Record<Key, string> = { usage: 'Closest to cap', total: 'Highest amount', title: 'Name A–Z', folder: 'Project A–Z' }

/** the hero reads like every other: what is priced, against the sum of list caps, with Used and Left on the right */
export function ActiveBudgets() {
  const { lists, folders } = useModel()
  const { listMenu, openLists, deleteLists } = useActions()
  const [key, setKey] = useState<Key>('usage')
  const [view, setView] = useState<'all' | 'attention'>('all')
  const [selectMode, setSelectMode] = useState(false)
  const [sel, setSel] = useState<Set<string>>(new Set())

  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders])
  const live = useMemo(
    () => lists.filter((l) => counts(l) && l.total > 0 && !folderById.get(l.folderId)?.trashedAt && !folderById.get(l.folderId)?.archived),
    [lists, folderById],
  )
  const flagged = live.filter((l) => needsAttention(l.total, l.cap)).length

  const rows = useMemo(() => {
    const usage = (l: ListView) => (l.cap ? l.total / l.cap : 0)
    const name = (l: ListView) => folderById.get(l.folderId)?.name ?? ''
    const r = view === 'attention' ? live.filter((l) => needsAttention(l.total, l.cap)) : [...live]
    switch (key) {
      case 'usage': return r.sort((a, b) => usage(b) - usage(a))
      case 'title': return r.sort((a, b) => a.title.localeCompare(b.title, 'de'))
      case 'folder': return r.sort((a, b) => name(a).localeCompare(name(b), 'de') || b.total - a.total)
      default: return r.sort((a, b) => b.total - a.total)
    }
  }, [live, key, view, folderById])

  const budget = live.reduce((b, l) => (l.cap ? { total: b.total + l.total, cap: b.cap + l.cap } : b), { total: 0, cap: 0 })
  const total = live.reduce((x, l) => x + l.total, 0)
  const folderCount = new Set(live.map((l) => l.folderId)).size
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const done = () => {
    setSelectMode(false)
    setSel(new Set())
  }

  return (
    <PageFrame>
      <PageHeader
        title="Active Budgets"
        subtitle={live.length ? `${plural(live.length, 'priced list', 'priced lists')} in ${plural(folderCount, 'project', 'projects')}` : undefined}
      />
      {live.length === 0 ? (
        <EmptyState icon="account_balance_wallet" title="No priced lists yet" text="Lists with unit prices (offers, GAEB X84/X86, D84/D86) show up here." />
      ) : (
        <>
          <Summary
            label="Total of lists with a cap"
            amount={money(budget.total)}
            total={budget.total}
            cap={budget.cap}
            capLabel="in list caps"
            status={heroStatus(budget, live.map((l) => ({ tone: budgetStatus(l.total, l.cap).tone })), ['list', 'lists'])}
            meta={total !== budget.total ? <span className="num">{money(total)} across all {plural(live.length, 'list', 'lists')}</span> : undefined}
            onStatus={() => { setView('attention'); requestAnimationFrame(() => document.getElementById('sec-budgets')?.focus()) }}
          hint="Measured against each list's own cap."
          />
          <Section
            title="Budgets"
            id="sec-budgets"
            focusable
            count={rows.length}
            tools={
              <>
                {live.length > 3 && <SortMenu value={key} options={SORTS} onChange={setKey} noun="budgets" />}
                <ToolButton icon={selectMode ? 'close' : 'checklist'} active={selectMode} aria-pressed={selectMode} onClick={() => (selectMode ? done() : setSelectMode(true))}>
                  {selectMode ? 'Cancel' : 'Select'}
                </ToolButton>
              </>
            }
          >
            {((live.length > 3 && flagged > 0) || view !== 'all') && (
              <div className="mb-3">
                <Chips
                  label="Filter budgets"
                  value={view}
                  onChange={setView}
                  options={[
                    { key: 'all', label: 'All' },
                    { key: 'attention', label: 'Needs attention', count: flagged },
                  ]}
                />
              </div>
            )}
            <p className="sr-only" aria-live="polite">{view === 'attention' ? `Showing ${plural(rows.length, 'list', 'lists')} that need attention` : ''}</p>
            {rows.length === 0 ? (
              <EmptyState compact icon="check_circle" title="Nothing needs attention" text="Every list is below 75% of its cap." />
            ) : (
              <RowList>
                {rows.map((l) => {
                  const project = folderById.get(l.folderId)
                  const folder = project?.name
                  const title = displayTitle(listLabel(l, live).title, folder)
                  return (
                    <Row
                      key={l.id}
                      to={`/list/${l.id}`}
                      label={`${title}, ${folder}, ${money(l.total)}, ${budgetPhrase(l.total, l.cap)}`}
                      icon="request_quote"
                      tone={project?.tone ?? 'slate'}
                      title={title}
                      badge={<BudgetBadge total={l.total} cap={l.cap} />}
                      subtitle={[folder, phaseLabel(l), completeness(l)].filter(Boolean).join(' · ')}
                      amount={money(l.total)}
                      meta={<BudgetMini total={l.total} cap={l.cap} label={`${title}: share of cap used`} />}
                      menu={<RowMenu items={listMenu(l)} label={`Options for ${title}`} />}
                      selectMode={selectMode}
                      selected={sel.has(l.id)}
                      onToggle={() => toggle(l.id)}
                    />
                  )
                })}
              </RowList>
            )}
          </Section>
          <Dock
            open={selectMode}
            count={sel.size}
            noun="list"
            onOpen={() => {
              openLists([...sel])
              done()
            }}
            onDelete={() => {
              deleteLists(lists.filter((l) => sel.has(l.id)), done)
            }}
            onDone={done}
          />
        </>
      )}
    </PageFrame>
  )
}
