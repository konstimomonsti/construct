import { useState } from 'react'
import { Dialog, Icon } from './ui'
import { docUrl } from '../lib/data'
import { useUi } from '../lib/ui-store'

export default function DocViewer() {
  const d = useUi((s) => s.dialog)
  const close = useUi((s) => s.closeDialog)
  const cur = d?.kind === 'doc' ? d.doc : null
  const [last, setLast] = useState(cur)
  if (cur && cur !== last) setLast(cur)
  const doc = cur ?? last
  const url = doc ? docUrl(doc) : ''
  return (
    <Dialog
      open={!!cur}
      onClose={close}
      title={doc?.name ?? ''}
      description={doc?.pages ? `${doc.pages} pages` : 'PDF document'}
      width="max-w-5xl"
      footer={
        doc && (
          <>
            <a href={url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 shadow-xs hover:bg-slate-50">
              <Icon name="open_in_new" size={16} />
              Open in new tab
            </a>
            <a href={url} download={doc.name} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white shadow-sm shadow-brand-600/20 hover:bg-brand-700">
              <Icon name="download" size={16} />
              Download
            </a>
          </>
        )
      }
    >
      {cur && <iframe title={cur.name} src={url} className="h-[62vh] w-full rounded-lg border border-slate-200 bg-slate-50" />}
    </Dialog>
  )
}
