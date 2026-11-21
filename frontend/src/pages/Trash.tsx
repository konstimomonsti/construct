import { Button, toast } from '../components/ui'
import { Avatar, EmptyState, PageFrame, PageHeader, PillLink, RowList, Section } from '../components/Kit'
import { phaseLabel } from '../components/ListCard'
import { useModel, useStore } from '../lib/store'
import { useUi } from '../lib/ui-store'
import { plural, relativeDate } from '../lib/format'

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

  const Row = ({ icon, title, sub, when, onRestore, onPurge }: { icon: string; title: string; sub: string; when?: string; onRestore: () => void; onPurge: () => void }) => (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl px-3 py-3 sm:flex-nowrap sm:px-4">
      <Avatar icon={icon} tone="slate" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold text-slate-900">{title}</div>
        <div className="truncate text-sm text-slate-600">{sub}{when ? ` · deleted ${relativeDate(when)}` : ''}</div>
      </div>
      <div className="flex w-full shrink-0 gap-2 pl-15 sm:w-auto sm:pl-0">
        <Button icon="restore_from_trash" onClick={onRestore} aria-label={`Restore ${title}`}>Restore</Button>
        <Button variant="ghost" className="text-rose-700 hover:bg-rose-50 hover:text-rose-800" onClick={onPurge} aria-label={`Delete ${title} forever`}>Delete forever</Button>
      </div>
    </div>
  )

  return (
    <PageFrame>
      <PageHeader title="Trash" subtitle="Restore or delete items forever from their More options menu." />
      {!tf.length && !tl.length ? (
        <EmptyState icon="delete" title="Trash is empty" text="Projects and lists you move to Trash show up here.">
          <PillLink to="/" icon="arrow_back">Go to All Projects</PillLink>
        </EmptyState>
      ) : (
        <div>
          {tf.length > 0 && (
            <Section title="Projects" count={tf.length}>
              <RowList>
                {tf.map((f) => (
                  <Row
                    key={f.id}
                    icon={f.icon}
                    title={f.name}
                    sub={plural(f.listMetas.length, 'list', 'lists')}
                    when={f.trashedAt}
                    onRestore={() => {
                      useStore.getState().patchFolder(f.id, { trashedAt: undefined })
                      toast(`Restored "${f.name}"`)
                    }}
                    onPurge={() => purgeFolder(f.id, f.name)}
                  />
                ))}
              </RowList>
            </Section>
          )}
          {tl.length > 0 && (
            <Section title="Lists" count={tl.length}>
              <RowList>
                {tl.map((l) => (
                  <Row
                    key={l.id}
                    icon="request_quote"
                    title={l.title}
                    sub={[phaseLabel(l), plural(l.positionsCount, 'position', 'positions')].join(' · ')}
                    when={l.trashedAt}
                    onRestore={() => {
                      useStore.getState().patchList(l.id, { trashedAt: undefined })
                      toast(`Restored "${l.title}"`)
                    }}
                    onPurge={() => purgeList(l.id, l.title)}
                  />
                ))}
              </RowList>
            </Section>
          )}
        </div>
      )}
    </PageFrame>
  )
}
