import { lazy, Suspense, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Dialog, Field, inputCls, toast } from './ui'
import { niceCap } from '../lib/format'
import { useModel, useStore } from '../lib/store'
import { useUi } from '../lib/ui-store'
import { makeListDoc } from '../lib/import'

const DocViewer = lazy(() => import('./DocViewer'))

export function Dialogs() {
  const d = useUi((s) => s.dialog)
  const close = useUi((s) => s.closeDialog)
  return (
    <>
      <NewFolder open={d?.kind === 'new-folder'} parent={d?.kind === 'new-folder' ? d.parent : undefined} onClose={close} />
      {d?.kind === 'rename-folder' && <Rename key={d.id} kind="folder" id={d.id} onClose={close} />}
      {d?.kind === 'rename-list' && <Rename key={d.id} kind="list" id={d.id} onClose={close} />}
      {d?.kind === 'cap' && <CapDialog key={`${d.target}-${d.id}`} target={d.target} id={d.id} prefill={d.prefill} onClose={close} />}
      {d?.kind === 'blank-list' && <BlankList folderId={d.folderId} onClose={close} />}
      <Confirm />
      {d?.kind === 'doc' && (
        <Suspense fallback={null}>
          <DocViewer />
        </Suspense>
      )}
    </>
  )
}

function NewFolder({ open, parent, onClose }: { open: boolean; parent?: string; onClose: () => void }) {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    const id = useStore.getState().createFolder(n, desc.trim() || (parent ? `in ${parent}` : ''))
    toast(`Created folder "${n}"`)
    setName('')
    setDesc('')
    onClose()
    navigate(`/folder/${id}`)
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={parent ? 'Create Subfolder' : 'New Folder'}
      description={parent ? `Specify a name for this new folder inside "${parent}".` : 'Give the new folder a name. You can import item lists into it afterwards.'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-folder-form" disabled={!name.trim()}>Create folder</Button>
        </>
      }
    >
      <form id="new-folder-form" onSubmit={submit} className="space-y-3">
        <Field label="Folder name">
          <input data-autofocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Legal & Compliance" maxLength={80} />
        </Field>
        <Field label="Description (optional)">
          <input className={inputCls} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Awaiting initial line allocations" maxLength={120} />
        </Field>
      </form>
    </Dialog>
  )
}

function Rename({ kind, id, onClose }: { kind: 'folder' | 'list'; id: string; onClose: () => void }) {
  const { folders, lists } = useModel()
  const current = kind === 'folder' ? folders.find((f) => f.id === id)?.name : lists.find((l) => l.id === id)?.title
  const [name, setName] = useState(current ?? '')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    if (kind === 'folder') useStore.getState().patchFolder(id, { name: n })
    else useStore.getState().patchList(id, { title: n })
    toast(`Renamed to "${n}"`)
    onClose()
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={kind === 'folder' ? 'Rename folder' : 'Rename list'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="rename-form" disabled={!name.trim()}>Save</Button>
        </>
      }
    >
      <form id="rename-form" onSubmit={submit}>
        <Field label="Name">
          <input data-autofocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        </Field>
      </form>
    </Dialog>
  )
}

function CapDialog({ target, id, prefill, onClose }: { target: 'folder' | 'list'; id: string; prefill?: number; onClose: () => void }) {
  const { folders, lists } = useModel()
  const item = target === 'folder' ? folders.find((f) => f.id === id) : lists.find((l) => l.id === id)
  const [val, setVal] = useState(String(prefill ?? (item?.cap || (item ? niceCap(item.total) : '') || '')))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const n = Number(val.replace(',', '.'))
    if (!Number.isFinite(n) || n < 0) return
    const cap = n === 0 ? null : n
    if (target === 'folder') useStore.getState().patchFolder(id, { cap })
    else useStore.getState().patchList(id, { cap })
    toast(cap ? `Budget cap set to €${n.toLocaleString('en-US')}` : 'Budget cap reset to automatic')
    onClose()
  }
  const name = item ? ('title' in item ? item.title : item.name) : ''
  return (
    <Dialog
      open
      onClose={onClose}
      title="Set budget cap"
      description={<>Ceiling for <span className="font-semibold text-slate-700">{name}</span> in EUR. Meters and alerts use this value. Enter 0 to reset to automatic.</>}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="cap-form">Save cap</Button>
        </>
      }
    >
      <form id="cap-form" onSubmit={submit}>
        <Field label="Budget cap (€)" hint={item ? `Current total: €${item.total.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : undefined}>
          <input data-autofocus type="number" min={0} step="any" inputMode="decimal" className={`${inputCls} font-mono`} value={val} onChange={(e) => setVal(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  )
}

function BlankList({ folderId, onClose }: { folderId: string; onClose: () => void }) {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    const doc = makeListDoc(folderId, n, `${n}.list`, [], { format: 'Eigene Liste' })
    useStore.getState().addList(doc)
    useStore.getState().openTab(doc.id)
    toast(`Created list "${n}"`)
    onClose()
    navigate(`/list/${doc.id}`)
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Create blank list"
      description="An empty ledger you can fill with items."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="blank-form" disabled={!name.trim()}>Create list</Button>
        </>
      }
    >
      <form id="blank-form" onSubmit={submit}>
        <Field label="List name">
          <input data-autofocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Elektroinstallation" maxLength={80} />
        </Field>
      </form>
    </Dialog>
  )
}

function Confirm() {
  const d = useUi((s) => s.dialog)
  const close = useUi((s) => s.closeDialog)
  const c = d?.kind === 'confirm' ? d : null
  const [last, setLast] = useState(c)
  if (c && c !== last) setLast(c)
  const shown = c ?? last
  return (
    <Dialog
      open={!!c}
      onClose={close}
      title={shown?.title ?? ''}
      description={shown?.body}
      width="max-w-sm"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant={shown?.danger ? 'danger' : 'primary'}
            onClick={() => {
              const run = shown?.run
              close()
              run?.()
            }}
          >
            {shown?.confirmLabel}
          </Button>
        </>
      }
    />
  )
}
