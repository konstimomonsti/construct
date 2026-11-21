import { Link } from 'react-router-dom'
import { Button, Icon, toast } from '../components/ui'
import { EmptyNote, Page } from '../components/Page'
import { useModel, useStore } from '../lib/store'
import { useUi } from '../lib/ui-store'
import { relativeDate } from '../lib/format'

export function Trash() {
  const { folders, lists } = useModel()
  const openDialog = useUi((s) => s.openDialog)
  const tf = folders.filter((f) => f.trashedAt)
  const tl = lists.filter((l) => l.trashedAt && l.trashedAt !== 'purged')

  const purgeFolder = (id: string, name: string) =>
    openDialog({
      kind: 'confirm',
      title: 'Delete forever?',
      body: `"${name}" and all lists you created in it will be removed permanently. This can't be undone.`,
      confirmLabel: 'Delete forever',
      danger: true,
      run: () => {
        useStore.getState().purgeFolder(id)
        toast(`Deleted "${name}"`)
      },
    })
  const purgeList = (id: string, name: string) =>
    openDialog({
      kind: 'confirm',
      title: 'Delete forever?',
      body: `"${name}" will be removed permanently. This can't be undone.`,
      confirmLabel: 'Delete forever',
      danger: true,
      run: () => {
        useStore.getState().patchList(id, { trashedAt: 'purged' })
        useStore.getState().closeTab(id)
        toast(`Deleted "${name}"`)
      },
    })

  const Row = ({ icon, title, sub, when, onRestore, onPurge, link }: { icon: string; title: string; sub: string; when?: string; onRestore: () => void; onPurge: () => void; link?: string }) => (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
        <Icon name={icon} size={18} />
      </span>
      <div className="min-w-0 flex-1">
        {link ? <Link to={link} className="block truncate text-sm font-semibold text-slate-900 hover:text-brand-600">{title}</Link> : <div className="truncate text-sm font-semibold text-slate-900">{title}</div>}
        <div className="truncate text-xs text-slate-500">{sub}{when ? ` · deleted ${relativeDate(when)}` : ''}</div>
      </div>
      <Button icon="restore_from_trash" onClick={onRestore}>Restore</Button>
      <Button variant="danger" icon="delete_forever" onClick={onPurge}>Delete forever</Button>
    </li>
  )

  return (
    <Page className="mx-auto w-full max-w-7xl px-4 pt-5 pb-16 sm:px-6">
      <div className="pb-4">
        <nav aria-label="Breadcrumb" className="mb-1 flex items-center gap-1.5 text-xs text-slate-500">
          <Link to="/" className="hover:text-slate-900">Home</Link>
          <Icon name="chevron_right" size={12} />
          <span className="font-medium text-slate-900">Trash</span>
        </nav>
        <h1 className="text-xl font-bold tracking-tight text-slate-900">Trash</h1>
      </div>
      {!tf.length && !tl.length ? (
        <EmptyNote icon="delete" title="Trash is empty" text="Folders and lists you move to Trash can be restored from here." />
      ) : (
        <div className="space-y-5">
          {tf.length > 0 && (
            <section aria-label="Trashed folders">
              <h2 className="mb-2 text-xs font-semibold tracking-wider text-slate-400 uppercase">Folders</h2>
              <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
                {tf.map((f) => (
                  <Row
                    key={f.id}
                    icon={f.icon}
                    title={f.name}
                    sub={`${f.listMetas.length} lists`}
                    when={f.trashedAt}
                    onRestore={() => {
                      useStore.getState().patchFolder(f.id, { trashedAt: undefined })
                      toast(`Restored "${f.name}"`)
                    }}
                    onPurge={() => purgeFolder(f.id, f.name)}
                  />
                ))}
              </ul>
            </section>
          )}
          {tl.length > 0 && (
            <section aria-label="Trashed lists">
              <h2 className="mb-2 text-xs font-semibold tracking-wider text-slate-400 uppercase">Lists</h2>
              <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
                {tl.map((l) => (
                  <Row
                    key={l.id}
                    icon="description"
                    title={l.title}
                    sub={l.fileName}
                    when={l.trashedAt}
                    onRestore={() => {
                      useStore.getState().patchList(l.id, { trashedAt: undefined })
                      toast(`Restored "${l.title}"`)
                    }}
                    onPurge={() => purgeList(l.id, l.title)}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Page>
  )
}
