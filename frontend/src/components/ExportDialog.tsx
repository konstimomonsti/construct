import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { Button, Dialog, Icon, toast } from './ui'
import { useStore } from '../lib/store'
import { indexTree, resolveList } from '../lib/resolve'
import {
  FORMATS, downloadResult, exportFileName, exportList, fidelityNote, isEdited, layoutLoader, originalLoader, ownFormat,
  type FormatId, type ExportRequest,
} from '../lib/export/index'
import type { DocMeta, ListDoc } from '../lib/types'

type Scope = 'all' | 'selection' | 'categories'

export function ExportDialog({
  open, onClose, listId, doc, original, selectedIds, initial,
}: { open: boolean; onClose: () => void; listId: string; doc: ListDoc; original?: DocMeta; selectedIds?: string[]; initial?: FormatId }) {
  const edits = useStore((s) => s.edits[listId])
  const resolved = useMemo(() => resolveList(doc, edits), [doc, edits])
  const categories = useMemo(() => [...indexTree(resolved.tree).node.values()], [resolved.tree])
  const own = ownFormat(doc)
  const [format, setFormat] = useState<FormatId>(initial ?? own ?? 'xlsx')
  const edited = useMemo(() => isEdited(doc, resolved.positions, format), [doc, resolved, format])
  const [scope, setScope] = useState<Scope>(() => selectedIds ? 'selection' : 'all')
  const [cats, setCats] = useState<Set<string>>(new Set())
  const [longTexts, setLongTexts] = useState(true)
  const [prices, setPrices] = useState(true)
  const [busy, setBusy] = useState(false)

  const info = FORMATS.find((f) => f.id === format)!
  const forcedOff = !!info.tender
  const forcedOn = !!info.priced
  const hasSel = selectedIds !== undefined
  const emptyScope = (scope === 'categories' && !cats.size) || (scope === 'selection' && !selectedIds?.length)
  const pricesOn = forcedOn ? true : forcedOff ? false : prices
  const canPrices = format !== 'json' || true
  const fileName = exportFileName(doc, format, edited || scope !== 'all')
  const loadOriginal = originalLoader(doc, original)

  const run = async () => {
    setBusy(true)
    try {
      const req: ExportRequest = {
        doc, resolved, format, scope,
        selectedIds: scope === 'selection' ? selectedIds : undefined,
        categoryOzs: scope === 'categories' ? [...cats] : undefined,
        longTexts, prices: pricesOn,
        loadOriginal,
        loadLayout: layoutLoader(doc),
        edited,
      }
      const res = await exportList(req)
      downloadResult(res)
      toast(`Exported ${res.fileName}`)
      onClose()
    } catch (e) {
      console.error(e)
      toast(`Export failed: ${(e as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const toggleCat = (oz: string) =>
    setCats((s) => {
      const n = new Set(s)
      if (n.has(oz)) n.delete(oz)
      else n.add(oz)
      return n
    })

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Export"
      description={`${doc.title} · ${resolved.positions.length} positions${edited ? ' · edited' : ''}`}
      width="max-w-2xl"
      footer={
        <>
          <span className="mr-auto truncate font-mono text-xs text-slate-600" title={fileName}>{fileName}</span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="file_download" disabled={busy || emptyScope} onClick={run}>
            {busy ? 'Exporting…' : 'Export'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {FORMATS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFormat(f.id)}
            aria-pressed={format === f.id}
            className={clsx(
              'flex flex-col items-start gap-1 rounded-lg border p-2.5 text-left transition-colors',
              format === f.id ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-slate-200 bg-white hover:bg-slate-50',
            )}
          >
            <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
              <Icon name={f.icon} size={16} className="text-slate-600" />
              {f.label}
            </span>
            <span className="text-xs leading-snug text-slate-600">{fidelityNote(doc, f.id, edited, !!loadOriginal && scope === 'all' && longTexts && (forcedOff || pricesOn))}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-xs font-semibold text-slate-700">Scope</legend>
          {(['all', 'selection', 'categories'] as Scope[]).map((s) => (
            <label key={s} className={clsx('flex items-center gap-2 text-xs text-slate-700', s === 'selection' && !hasSel && 'opacity-40')}>
              <input type="radio" name="scope" checked={scope === s} disabled={s === 'selection' && !hasSel} onChange={() => setScope(s)} />
              {s === 'all' ? 'Whole list' : s === 'selection' ? `Selected positions${hasSel ? ` (${selectedIds!.length})` : ''}` : 'Selected categories'}
            </label>
          ))}
          {scope === 'categories' && (
            <div className="max-h-32 space-y-1 overflow-auto rounded-lg border border-slate-200 p-2">
              {categories.map((c) => (
                <label key={c.oz} className="flex items-center gap-2 text-xs text-slate-700" style={{ paddingInlineStart: (c.depth - 1) * 12 }}>
                  <input type="checkbox" checked={cats.has(c.oz)} onChange={() => toggleCat(c.oz)} />
                  <span className="font-mono text-xs text-slate-600">{c.oz}</span>
                  <span className="truncate">{c.label}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-xs font-semibold text-slate-700">Content</legend>
          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input type="checkbox" checked={longTexts} onChange={(e) => setLongTexts(e.target.checked)} />
            Include long texts
          </label>
          <label className={clsx('flex items-center gap-2 text-xs text-slate-700', (forcedOn || forcedOff) && 'opacity-60')}>
            <input type="checkbox" checked={pricesOn && canPrices} disabled={forcedOn || forcedOff} onChange={(e) => setPrices(e.target.checked)} />
            Include prices
            {forcedOff && <span className="text-xs text-slate-600">(not part of tender formats)</span>}
            {forcedOn && <span className="text-xs text-slate-600">(always in this format)</span>}
          </label>
        </fieldset>
      </div>
    </Dialog>
  )
}
