import { useMemo, useState } from 'react'
import { BudgetMini, Chips, EmptyState, PageFrame, PageHeader, Row, RowList, RowMenu, Section, SortMenu, Summary, budgetPhrase } from '../components/Kit'
import { counts, useModel, type ListView } from '../lib/store'
import { moneyWhole, needsAttention, plural } from '../lib/format'
import { useActions } from '../lib/actions'
import { listLabel, phaseLabel } from '../components/ListCard'

type Key = 'total' | 'usage' | 'title' | 'folder'
const SORTS: Record<Key, string> = { total: 'Highest amount', usage: 'Closest to cap', title: 'Name A–Z', folder: 'Project A–Z' }

export function ActiveBudgets() {
  const { lists, folders } = useModel()
  const { listMenu } = useActions()
  const [key, setKey] = useState<Key>('total')
  const [view, setView] = useState<'all' | 'attention'>('all')

  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders])
  const live = useMemo(
    () => lists.filter((l) => counts(l) && l.total > 0 && !folderById.get(l.folderId)?.trashedAt && !folderById.get(l.folderId)?.archived),
    [lists, folderById],
  )
  const needs = (l: ListView) => needsAttention(l.total, l.cap)
  const flagged = live.filter(needs).length
  const over = live.filter((l) => l.cap && l.total > l.cap).length

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

  // measured against the lists' own caps, so this page does not repeat the All Projects number
  const budget = live.reduce((b, l) => (l.cap ? { total: b.total + l.total, cap: b.cap + l.cap } : b), { total: 0, cap: 0 })
  const total = live.reduce((x, l) => x + l.total, 0)
  const uncapped = live.filter((l) => !l.cap).length
  const folderCount = new Set(live.map((l) => l.folderId)).size

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
            label="Total of priced lists"
            amount={moneyWhole(total)}
            total={budget.total}
            cap={budget.cap}
            capLabel="in list caps"
            statusWord={flagged && !needsAttention(budget.total, budget.cap) ? 'On track overall' : undefined}
            meta={
              <>
                {flagged ? (
                  <button type="button" onClick={() => setView('attention')} className="rounded font-medium text-slate-900 underline decoration-slate-500 underline-offset-4 hover:decoration-slate-800">
                    {plural(flagged, 'list', 'lists')} near {flagged === 1 ? 'its' : 'their'} cap · {over ? `${over} over` : 'none over'}
                  </button>
                ) : (
                  'Every list is below 75% of its cap'
                )}
                {uncapped > 0 && budget.cap > 0 && <span className="num"> · {plural(uncapped, 'list', 'lists')} without a cap</span>}
              </>
            }
          />
          <Section
            title="Lists"
            count={rows.length}
            tools={<SortMenu value={key} options={SORTS} onChange={setKey} noun="lists" />}
          >
            <div className="mb-3 px-1">
              <Chips
                label="Filter lists"
                value={view}
                onChange={setView}
                options={[
                  { key: 'all', label: 'All' },
                  { key: 'attention', label: 'Needs attention', count: flagged },
                ]}
              />
            </div>
            {rows.length === 0 ? (
              <EmptyState icon="check_circle" title="Nothing needs attention" text="Every list is below 75% of its cap." />
            ) : (
              <RowList>
                {rows.map((l) => {
                  const lab = listLabel(l, live)
                  const folder = folderById.get(l.folderId)?.name
                  return (
                    <Row
                      key={l.id}
                      to={`/list/${l.id}`}
                      label={`${lab.title}, ${folder}, ${moneyWhole(l.total)}, ${budgetPhrase(l.total, l.cap)}`}
                      icon="request_quote"
                      tone={folderById.get(l.folderId)?.tone ?? 'indigo'}
                      title={lab.title}
                      subtitle={[folder, phaseLabel(l), plural(l.positionsCount, 'position', 'positions')].filter(Boolean).join(' · ')}
                      amount={moneyWhole(l.total)}
                      meta={<BudgetMini total={l.total} cap={l.cap} label={`${lab.title}: share of cap used`} />}
                      menu={<RowMenu items={listMenu(l)} label={`Options for ${lab.title}`} />}
                    />
                  )
                })}
              </RowList>
            )}
          </Section>
        </>
      )}
    </PageFrame>
  )
}
