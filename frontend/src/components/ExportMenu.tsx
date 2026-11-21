import { useMemo, useState } from 'react'
import { Button, Menu, toast, type MenuItem } from './ui'
import { ExportDialog } from './ExportDialog'
import { SubcontractOverlay } from './subcontract/SubcontractOverlay'
import { RequestQuotesOverlay } from './quotes/RequestQuotesOverlay'
import { useStore } from '../lib/store'
import { resolveList } from '../lib/resolve'
import { FORMATS, downloadResult, exportList, isEdited, layoutLoader, originalLoader, ownFormat, type FormatId } from '../lib/export/index'
import type { DocMeta, ListDoc } from '../lib/types'

export function ExportMenu({ listId, doc, selectedIds, original }: { listId: string; doc: ListDoc; selectedIds?: string[]; original?: DocMeta }) {
  const [dialog, setDialog] = useState<FormatId | null>(null)
  const [subcontract, setSubcontract] = useState(false)
  const [quotes, setQuotes] = useState(false)
  const edits = useStore((s) => s.edits[listId])
  const resolved = useMemo(() => resolveList(doc, edits), [doc, edits])
  const own = ownFormat(doc)

  const quick = async (format: FormatId) => {
    try {
      const res = await exportList({
        doc, resolved, format, longTexts: true, prices: true,
        scope: selectedIds?.length ? 'selection' : 'all',
        selectedIds: selectedIds?.length ? selectedIds : undefined,
        loadOriginal: originalLoader(doc, original), loadLayout: layoutLoader(doc), edited: isEdited(doc, resolved.positions),
      })
      downloadResult(res)
      toast(`Exported ${res.fileName}`)
    } catch (e) {
      console.error(e)
      toast(`Export failed: ${(e as Error).message}`, 'error')
    }
  }

  const ids: FormatId[] = ['csv', 'xlsx', 'pdf']
  const items: (MenuItem | 'sep')[] = ids.map((id) => {
    const f = FORMATS.find((x) => x.id === id)!
    return { label: f.label, icon: f.icon, onSelect: () => quick(id) }
  })
  if (own && !ids.includes(own)) {
    const f = FORMATS.find((x) => x.id === own)!
    items.push({ label: `${f.label} (original format)`, icon: f.icon, onSelect: () => quick(own) })
  }
  items.push('sep', { label: 'More formats…', icon: 'tune', onSelect: () => setDialog(own ?? 'xlsx') })
  items.push({ label: 'Request quotes from suppliers…', icon: 'request_quote', onSelect: () => setQuotes(true) })
  items.push({ label: 'Send to subcontractor…', icon: 'engineering', onSelect: () => setSubcontract(true) })

  return (
    <>
      <Menu
        label="Export"
        width="w-64"
        items={items}
        trigger={(p) => (
          <Button {...p} icon="download" className="max-sm:w-10 max-sm:px-0">
            <span className="max-sm:sr-only">Export{selectedIds?.length ? ` ${selectedIds.length}` : ''}</span>
          </Button>
        )}
      />
      {dialog && <ExportDialog open onClose={() => setDialog(null)} listId={listId} doc={doc} original={original} selectedIds={selectedIds} initial={dialog} />}
      <SubcontractOverlay open={subcontract} onClose={() => setSubcontract(false)} listId={listId} doc={doc} resolved={resolved} selectedIds={selectedIds} />
      <RequestQuotesOverlay open={quotes} onClose={() => setQuotes(false)} listId={listId} doc={doc} resolved={resolved} selectedIds={selectedIds} />
    </>
  )
}
