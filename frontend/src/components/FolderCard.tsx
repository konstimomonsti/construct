import { RowMenu, Row, RowList, BudgetMini, budgetPhrase } from './Kit'
import { moneyWhole, plural } from '../lib/format'
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
      label={`${f.name}, ${lists}, ${moneyWhole(f.total)}, ${budgetPhrase(f.total, f.cap)}`}
      icon={f.icon}
      tone={f.tone}
      title={f.name}
      subtitle={[lists, folderDescription(f)].filter(Boolean).join(' · ')}
      amount={f.total ? moneyWhole(f.total) : undefined}
      meta={!f.total && f.listMetas.length ? <span className="text-sm text-slate-600">{plural(f.listMetas.length, 'list', 'lists')} to price</span> : <BudgetMini total={f.total} cap={f.cap} label={`${f.name} budget used`} />}
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
