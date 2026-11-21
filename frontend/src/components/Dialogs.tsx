import { lazy, Suspense, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Dialog, Field, inputCls, toast } from './ui'
import { folderPath, useModel, useStore } from '../lib/store'
import { useUi, type DialogState } from '../lib/ui-store'
import { makeListDoc, pickAndImport } from '../lib/import'
import type { DocMeta } from '../lib/types'

const DocViewer = lazy(() => import('./DocViewer'))

export function Dialogs() {
  const d = useUi((s) => s.dialog)
  const close = useUi((s) => s.closeDialog)
  return (
    <>
      <NewFolder open={d?.kind === 'new-folder'} parent={d?.kind === 'new-folder' ? d.parent : undefined} onClose={close} />
      {d?.kind === 'rename-folder' && <Rename key={d.id} kind="folder" id={d.id} onClose={close} />}
      {d?.kind === 'rename-list' && <Rename key={d.id} kind="list" id={d.id} onClose={close} />}
      {d?.kind === 'blank-list' && <BlankList folderId={d.folderId} onClose={close} />}
      {d?.kind === 'folder-target' && <FolderTarget dialog={d} onClose={close} />}
      {d?.kind === 'link-document' && <LinkDocument doc={d.doc} onClose={close} />}
      <Confirm />
      {d?.kind === 'doc' && (
        <Suspense fallback={null}>
          <DocViewer key={d.doc.id} />
        </Suspense>
      )}
    </>
  )
}

function NewFolder({ open, parent, onClose }: { open: boolean; parent?: string; onClose: () => void }) {
  const navigate = useNavigate()
  const { folders } = useModel()
  const parentName = folders.find((folder) => folder.id === parent)?.name
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    const id = useStore.getState().createFolder(n, desc.trim(), parent)
    toast(parent ? `Created folder "${n}"` : `Created project "${n}"`)
    setName('')
    setDesc('')
    onClose()
    navigate(`/folder/${id}`)
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={parent ? 'New folder' : 'New project'}
      description={parentName ? `Create a folder inside "${parentName}".` : 'Name the project. You can upload GAEB, CSV or PDF lists into it afterwards.'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-folder-form" disabled={!name.trim()}>{parent ? 'Create folder' : 'Create project'}</Button>
        </>
      }
    >
      <form id="new-folder-form" onSubmit={submit} className="space-y-3">
        <Field label={parent ? 'Folder name' : 'Project name'}>
          <input data-autofocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder={parent ? 'e.g. Rohbau' : 'e.g. Neubau Kita Ringstraße'} maxLength={80} />
        </Field>
        <Field label="Description (optional)">
          <input className={inputCls} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Client, address or phase" maxLength={120} />
        </Field>
      </form>
    </Dialog>
  )
}

function FolderTarget({ dialog, onClose }: { dialog: Extract<DialogState, { kind: 'folder-target' }>; onClose: () => void }) {
  const navigate = useNavigate()
  const { folders, lists } = useModel()
  const openDialog = useUi((s) => s.openDialog)
  const [folderId, setFolderId] = useState('')
  const list = dialog.action === 'move-list' ? lists.find((item) => item.id === dialog.listId) : undefined
  const fromDocument = dialog.action === 'move-document' ? folders.find((folder) => folder.documents.some((doc) => doc.id === dialog.docId)) : undefined
  const sourceFolder = dialog.action === 'move-folder' ? folders.find((folder) => folder.id === dialog.folderId) : undefined
  const currentFolder = sourceFolder?.parentId ?? list?.folderId ?? fromDocument?.id
  const options = folders.flatMap((folder) => {
    const path = folderPath(folders, folder.id)
    return folder.id === currentFolder || path.some((part) => part.trashedAt || part.id === sourceFolder?.id) ? []
      : [{ id: folder.id, name: path.map((part) => part.name).join(' / ') }]
  }).sort((a, b) => a.name.localeCompare(b.name))
  const rootOption = 'workspace-root'
  if (sourceFolder?.parentId) options.unshift({ id: rootOption, name: 'Workspace (top level)' })
  const move = dialog.action !== 'import'
  const submit = () => {
    const target = options.find((option) => option.id === folderId)
    if (!target) return
    onClose()
    if (sourceFolder) {
      if (useStore.getState().moveFolder(sourceFolder.id, folderId === rootOption ? null : folderId)) {
        toast(`Moved "${sourceFolder.name}" to "${target.name}"`)
      }
    } else if (dialog.action === 'move-document') {
      useStore.getState().moveDocument(dialog.docId, folderId)
      toast(`Moved document to "${target.name}"`)
    } else if (list) {
      useStore.getState().patchList(list.id, { folderId })
      toast(`Moved "${list.title}" to "${target.name}"`)
    } else if (!move) {
      pickAndImport(folderId, (result) => {
        if (result.lists.length || result.docs) navigate(`/folder/${folderId}`)
      })
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={move ? 'Move to folder' : 'Choose an import folder'}
      description={dialog.action === 'move-document' ? 'The document will keep its link to the list.'
        : sourceFolder ? 'Choose where to move this folder and its contents.'
          : move ? 'Documents stored with the list will move with it.' : 'Choose the project or folder these files belong to.'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {!move && !options.length && <Button onClick={() => openDialog({ kind: 'new-folder' })}>New project</Button>}
          <Button variant="primary" disabled={!options.some((option) => option.id === folderId)} onClick={submit}>{move ? 'Move' : 'Choose files'}</Button>
        </>
      }
    >
      <Field label="Destination">
        <select data-autofocus className={inputCls} value={folderId} onChange={(event) => setFolderId(event.target.value)}>
          <option value="">Select a project or folder</option>
          {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
      </Field>
    </Dialog>
  )
}

function LinkDocument({ doc, onClose }: { doc: DocMeta; onClose: () => void }) {
  const { folders, lists } = useModel()
  const [listId, setListId] = useState(doc.listId ?? '')
  const options = lists.flatMap((list) => {
    const path = folderPath(folders, list.folderId)
    return list.trashedAt || !path.length || path.some((folder) => folder.trashedAt) ? []
      : [{ id: list.id, name: [...path.map((folder) => folder.name), list.title].join(' / ') }]
  }).sort((a, b) => a.name.localeCompare(b.name))
  return (
    <Dialog
      open
      onClose={onClose}
      title="Change linked list"
      description={`Choose the list that "${doc.name}" belongs to.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={listId === doc.listId || !options.some((option) => option.id === listId)} onClick={() => {
            useStore.getState().linkDocument(doc.id, listId)
            toast('Document linked to its new list')
            onClose()
          }}>Link document</Button>
        </>
      }
    >
      <Field label="Linked list">
        <select data-autofocus className={inputCls} value={listId} onChange={(event) => setListId(event.target.value)}>
          <option value="">Select a list</option>
          {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
      </Field>
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
