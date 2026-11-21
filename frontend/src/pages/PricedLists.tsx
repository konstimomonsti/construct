import { useMemo, useState } from 'react'
import { EmptyState, PageFrame, PageHeader, Row, RowList, RowMenu, Section, SortMenu, Summary, ToolButton } from '../components/Kit'
import { Dock } from '../components/Dock'
import { counts, useModel, type ListView } from '../lib/store'
import { money, plural } from '../lib/format'
import { useActions } from '../lib/actions'
import { completeness, displayTitle, listLabel, phaseLabel } from '../components/ListCard'

type Key = 'total' | 'title' | 'folder'
const SORTS: Record<Key, string> = { total: 'Highest amount', title: 'Name A–Z', folder: 'Project A–Z' }

export function PricedLists() {
  const { lists, folders } = useModel()
  const { listMenu, openLists, deleteLists } = useActions()
  const [key, setKey] = useState<Key>('total')
  const [selectMode, setSelectMode] = useState(false)
  const [sel, setSel] = useState<Set<string>>(new Set())

  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders])
  const live = useMemo(
    // a list whose prices were all saved as zero is still priced
    () => lists.filter((l) => counts(l) && (l.total > 0 || l.pricedCount > 0) && !folderById.get(l.folderId)?.trashedAt && !folderById.get(l.folderId)?.archived),
    [lists, folderById],
  )
  const rows = useMemo(() => {
    const name = (l: ListView) => folderById.get(l.folderId)?.name ?? ''
    const r = [...live]
    switch (key) {
      case 'title': return r.sort((a, b) => a.title.localeCompare(b.title, 'de'))
      case 'folder': return r.sort((a, b) => name(a).localeCompare(name(b), 'de') || b.total - a.total)
      default: return r.sort((a, b) => b.total - a.total)
    }
  }, [live, key, folderById])

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
        title="Priced Lists"
        subtitle={live.length ? `${plural(live.length, 'priced list', 'priced lists')} in ${plural(folderCount, 'project', 'projects')}` : undefined}
      />
      {live.length === 0 ? (
        <EmptyState icon="account_balance_wallet" title="No priced lists yet" text="Lists with unit prices (offers, GAEB X84/X86, D84/D86) show up here." />
      ) : (
        <>
          <Summary label="Total of priced lists" amount={money(total)} />
          <Section
            title="Lists"
            count={rows.length}
            tools={
              <>
                {live.length > 3 && <SortMenu value={key} options={SORTS} onChange={setKey} noun="lists" />}
                <ToolButton icon={selectMode ? 'close' : 'checklist'} active={selectMode} aria-pressed={selectMode} onClick={() => (selectMode ? done() : setSelectMode(true))}>
                  {selectMode ? 'Cancel' : 'Select'}
                </ToolButton>
              </>
            }
          >
            <RowList>
              {rows.map((l) => {
                const project = folderById.get(l.folderId)
                const folder = project?.name
                const title = displayTitle(listLabel(l, live).title, folder)
                return (
                  <Row
                    key={l.id}
                    to={`/list/${l.id}`}
                    label={[title, folder, phaseLabel(l), money(l.total), completeness(l)].filter(Boolean).join(', ')}
                    icon="request_quote"
                    tone={project?.tone ?? 'slate'}
                    title={title}
                    subtitle={[folder, phaseLabel(l), completeness(l)].filter(Boolean).join(' · ')}
                    amount={money(l.total)}
                    menu={<RowMenu items={listMenu(l)} label={`Options for ${title}`} />}
                    selectMode={selectMode}
                    selected={sel.has(l.id)}
                    onToggle={() => toggle(l.id)}
                  />
                )
              })}
            </RowList>
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
