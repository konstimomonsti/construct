import { useEffect, useState } from 'react'
import { Dialog, Icon } from './ui'
import { docUrl } from '../lib/data'
import { loadDocument } from '../lib/documents'
import { useUi } from '../lib/ui-store'

export default function DocViewer() {
  const dialog = useUi((s) => s.dialog)
  const close = useUi((s) => s.closeDialog)
  const doc = dialog?.kind === 'doc' ? dialog.doc : null
  const [localUrl, setLocalUrl] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const storedId = doc?.stored ? doc.id : undefined
  useEffect(() => {
    if (!storedId) return
    let active = true
    let objectUrl = ''
    loadDocument(storedId).then((blob) => {
      if (!active) return
      if (!blob) {
        setUnavailable(true)
        return
      }
      objectUrl = URL.createObjectURL(blob)
      setLocalUrl(objectUrl)
    }).catch(() => { if (active) setUnavailable(true) })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [storedId])

  if (!doc) return null
  const url = doc.stored ? localUrl : docUrl(doc)
  const pdf = /\.pdf$/i.test(doc.name)
  const description = pdf ? (doc.pages ? `${doc.pages} pages` : 'PDF document') : 'Original source file'
  return (
    <Dialog
      open
      onClose={close}
      title={doc.name}
      description={description}
      width="max-w-5xl"
      footer={url && (
        <>
          {pdf && (
            <a href={url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 shadow-xs hover:bg-slate-50">
              <Icon name="open_in_new" size={16} />
              Open in new tab
            </a>
          )}
          <a href={url} download={doc.name} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white shadow-sm shadow-brand-600/20 hover:bg-brand-700">
            <Icon name="download" size={16} />
            Download
          </a>
        </>
      )}
    >
      {url && pdf && <iframe title={doc.name} src={url} className="h-[62vh] w-full rounded-lg border border-slate-200 bg-slate-50" />}
      {!url && <p role="status" className="text-sm text-slate-500">{unavailable ? 'The original file is unavailable.' : 'Loading document…'}</p>}
    </Dialog>
  )
}
