import { clsx } from 'clsx'
import { useRef, useState } from 'react'
import { Button, Icon, toast } from '../ui'
import { removeDocuments, saveDocument } from '../../lib/documents'
import { useStore } from '../../lib/store'
import type { DocMeta } from '../../lib/types'

const ACCEPT = '.x86,.d86,.pdf,.docx'
const OK = /\.(x86|d86|pdf|docx)$/i

/** X86 phase: the award document (Auftrag) of the client. It is stored like every other attached document. */
export function AwardTab({ listId, award, onOpen }: { listId: string; award?: DocMeta; onOpen: (doc: DocMeta) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)

  const upload = async (file: File | undefined) => {
    if (!file || busy) return
    if (!OK.test(file.name)) {
      toast('Please choose an X86, D86, PDF or Word file', 'error')
      return
    }
    setBusy(true)
    const doc: DocMeta = {
      id: `d-${crypto.randomUUID()}`, name: file.name, file: '', pages: 0, excerpt: `${(file.size / 1024).toFixed(0)} KB`, listId, stored: true,
    }
    try {
      await saveDocument(doc.id, file)
      if (!useStore.getState().addImportedFile(doc)) {
        removeDocuments([doc.id])
        throw new Error('The destination list is unavailable.')
      }
      const before = useStore.getState().listPatch[listId]?.awardDocumentId
      useStore.getState().patchList(listId, { awardDocumentId: doc.id })
      toast(`Attached ${file.name} as the award document`, 'ok', { label: 'Undo', run: () => useStore.getState().patchList(listId, { awardDocumentId: before }) })
    } catch (e) {
      toast(`The award document could not be saved: ${(e as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      {award && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg ring-1 ring-slate-200 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Icon name="verified" size={22} fill className="shrink-0 text-emerald-700" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-900">{award.name}</div>
              <div className="text-[13px] text-slate-600">Award document{award.excerpt ? ` · ${award.excerpt}` : ''}</div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button icon="open_in_new" onClick={() => onOpen(award)}>Open</Button>
            <Button icon="swap_horiz" onClick={() => input.current?.click()} disabled={busy}>Replace</Button>
          </div>
        </div>
      )}

      {!award && (
        <div
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); void upload(e.dataTransfer.files[0]) }}
          className={clsx('flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-5 py-10 text-center transition-colors', over ? 'border-brand-600 bg-brand-50' : 'border-slate-300 bg-slate-50')}
        >
          <Icon name="upload_file" size={30} className="text-slate-500" />
          <p className="max-w-md text-sm text-slate-700">Drop the award document (Auftrag, X86 or PDF) here once the client has decided.</p>
          <Button variant="primary" icon="upload" onClick={() => input.current?.click()} disabled={busy}>Upload award document</Button>
        </div>
      )}

      <input ref={input} type="file" accept={ACCEPT} hidden aria-label="Award document" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = '' }} />
    </div>
  )
}
