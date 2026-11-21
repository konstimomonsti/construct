import { RowMenu, Row, RowList } from './Kit'
import { int, money, plural } from '../lib/format'
import { useActions } from '../lib/actions'
import { folderDescription, type FolderView } from '../lib/store'

export { toneTile } from './Kit'
export { RowMenu as MoreMenu } from './Kit'

export function FolderRow({ folder: f, selectMode, selected, onToggle }: { folder: FolderView; selectMode?: boolean; selected?: boolean; onToggle?: () => void }) {
  const { folderMenu } = useActions()
  // read from confirmed position counts: a saved zero price is still a price
  const priced = f.total > 0 || f.priced > 0
  const lists = plural(f.listMetas.length, 'list', 'lists')
  const coverage = priced && f.priced < f.positions ? `${int(f.priced)} of ${plural(f.positions, 'position', 'positions')} priced` : ''
  return (
    <Row
      dataRow="folder"
      to={`/folder/${f.id}`}
      label={[f.name, lists, priced && money(f.total), coverage].filter(Boolean).join(', ')}
      icon={f.icon}
      tone={f.tone}
      title={f.name}
      subtitle={[priced && lists, folderDescription(f).split(' · ')[0]].filter(Boolean).join(' · ') || undefined}
      amount={priced ? money(f.total) : <span className="font-medium text-slate-600">{lists}</span>}
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
