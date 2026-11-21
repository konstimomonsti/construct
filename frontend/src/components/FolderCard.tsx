import { RowMenu, Row, RowList, BudgetBadge, BudgetMini, budgetPhrase } from './Kit'
import { Meter } from './ui'
import { int, money, plural } from '../lib/format'
import { useActions } from '../lib/actions'
import { folderDescription, type FolderView } from '../lib/store'

export { toneTile } from './Kit'
export { RowMenu as MoreMenu } from './Kit'

export function FolderRow({ folder: f, selectMode, selected, onToggle }: { folder: FolderView; selectMode?: boolean; selected?: boolean; onToggle?: () => void }) {
  const { folderMenu } = useActions()
  const lists = f.listMetas.length ? plural(f.listMetas.length, 'list', 'lists') : 'No lists yet'
  return (
    <Row
      dataRow="folder"
      to={`/folder/${f.id}`}
      label={`${f.name}, ${lists}, ${f.total ? money(f.total) : 'not priced yet'}, ${budgetPhrase(f.total, f.cap)}`}
      icon={f.icon}
      tone={f.tone}
      title={f.name}
      badge={<BudgetBadge total={f.total} cap={f.cap} />}
      subtitle={[lists, folderDescription(f).split(' · ')[0]].filter(Boolean).join(' · ')}
      amount={f.total ? money(f.total) : <span className="font-medium text-slate-500">Not priced</span>}
      meta={
        !f.total && f.positions ? (
          <span className="flex items-center justify-end gap-2 text-sm whitespace-nowrap text-slate-600">
            <span className="num">{int(f.priced)} of {int(f.positions)} priced</span>
            <Meter value={(f.priced / f.positions) * 100} tone="brand" className="w-12 flex-none sm:w-14" label={`${f.name}: positions priced`} />
          </span>
        ) : (
          <BudgetMini total={f.total} cap={f.cap} label={`${f.name} budget used`} />
        )
      }
      menu={<RowMenu items={folderMenu(f)} label={`Options for ${f.name}`} />}
      selectMode={selectMode}
      selected={selected}
      onToggle={onToggle}
    />
  )
}

export function FolderGrid({
  folders, selectMode, selected, onToggle,
}: {
  folders: FolderView[]
  selectMode?: boolean
  selected?: Set<string>
  onToggle?: (id: string) => void
}) {
  return (
    <RowList>
      {folders.map((f) => (
        <FolderRow key={f.id} folder={f} selectMode={selectMode} selected={selected?.has(f.id)} onToggle={() => onToggle?.(f.id)} />
      ))}
    </RowList>
  )
}
