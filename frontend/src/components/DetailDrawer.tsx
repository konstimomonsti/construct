import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Icon, IconButton, inputCls } from './ui'
import { money } from '../lib/format'
import { positionTotal } from '../lib/money'
import { unitIcon } from '../lib/actions'
import type { Position } from '../lib/types'

const numStr = (n: number) => String(Math.round(n * 1000) / 1000)
const parseNum = (s: string) => {
  const t = s.trim().replace(/\s/g, '')
  if (t === '') return NaN
  return Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t)
}

function Labeled({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block space-y-1 ${className ?? ''}`}>
      <span className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">{label}</span>
      {children}
    </label>
  )
}

export function DetailDrawer({
  p, catalogue, onClose, edited, added, onPatch, onQty, onUp, onReset, onMoveCategory,
}: {
  p: Position | null
  catalogue?: React.ReactNode
  onClose: () => void
  edited: boolean
  added: boolean
  onPatch: (patch: Partial<Pick<Position, 'short' | 'long' | 'unit'>>) => void
  onQty: (n: number) => void
  onUp: (n: number | null) => void
  onReset: () => void
  onMoveCategory: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const [moving, setMoving] = useState(false)
  useEffect(() => {
    if (!p) return
    const prev = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('[role=dialog][aria-labelledby]:not([aria-label])') && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [p?.id, onClose]) // eslint-disable-line react-hooks/exhaustive-deps

  const leaf = p?.path?.[p.path.length - 1]

  return createPortal(
    <AnimatePresence>
      {p && (
        <div className="fixed inset-0 z-[75]">
          <motion.div className="absolute inset-0 bg-slate-900/20" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} onClick={onClose} />
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label={`Position ${p.oz}`}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%', transition: { duration: 0.16 } }}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
            className="absolute top-0 right-0 flex h-full w-full max-w-lg flex-col border-l border-slate-200 bg-white shadow-2xl"
          >
            <div className="flex items-start gap-3 border-b border-slate-100 px-5 py-4">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-100 text-slate-600">
                <Icon name={unitIcon(p.unit)} size={19} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-mono text-[11px] text-slate-400">
                  OZ: {p.oz}
                  {edited && <span className="rounded bg-amber-100 px-1.5 py-px font-sans text-[10px] font-semibold text-amber-700" data-testid="edited-badge">edited</span>}
                  {added && <span className="rounded bg-emerald-100 px-1.5 py-px font-sans text-[10px] font-semibold text-emerald-700">added</span>}
                </div>
                <h2 className="font-heading text-base leading-snug font-bold tracking-tight text-slate-900">
                  {p.short && p.short !== '(ohne Kurztext)' ? p.short : <span className="font-normal text-slate-400 italic">(ohne Kurztext)</span>}
                </h2>
              </div>
              <IconButton ref={closeRef} icon="close" label="Close details" onClick={onClose} />
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4" key={p.id}>
              {catalogue}
              <Labeled label="Kurztext">
                <input
                  key={`s-${p.short}`}
                  aria-label="Kurztext"
                  className={inputCls}
                  defaultValue={p.short === '(ohne Kurztext)' ? '' : p.short}
                  onBlur={(e) => e.target.value.trim() !== p.short && onPatch({ short: e.target.value.trim() })}
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  maxLength={300}
                />
              </Labeled>
              <div className="grid grid-cols-3 gap-3">
                <Labeled label="Menge">
                  <input
                    key={`q-${p.qty}`}
                    aria-label="Menge"
                    inputMode="decimal"
                    className={`${inputCls} font-mono`}
                    defaultValue={numStr(p.qty)}
                    onBlur={(e) => {
                      const n = parseNum(e.target.value)
                      if (Number.isFinite(n) && n >= 0 && n !== p.qty) onQty(Math.round(n * 1000) / 1000)
                      else e.target.value = numStr(p.qty)
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  />
                </Labeled>
                <Labeled label="Einheit">
                  <input key={`u-${p.unit}`} aria-label="Einheit" className={inputCls} defaultValue={p.unit} onBlur={(e) => e.target.value.trim() !== p.unit && onPatch({ unit: e.target.value.trim() })} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} maxLength={12} />
                </Labeled>
                <Labeled label="Einheitspreis €">
                  <input
                    key={`e-${p.up}`}
                    aria-label="Einheitspreis"
                    inputMode="decimal"
                    className={`${inputCls} font-mono`}
                    defaultValue={p.up == null ? '' : String(p.up)}
                    placeholder="—"
                    onBlur={(e) => {
                      const t = e.target.value.trim()
                      if (t === '') return p.up !== null ? onUp(null) : undefined
                      const n = parseNum(t)
                      if (Number.isFinite(n) && n >= 0 && n !== p.up) onUp(Math.round(n * 100) / 100)
                      else e.target.value = p.up == null ? '' : String(p.up)
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  />
                </Labeled>
              </div>
              <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-2.5 text-xs">
                <span className="font-semibold tracking-wider text-slate-400 uppercase">Gesamt</span>
                <span className="font-mono text-sm font-bold text-slate-900">{p.up == null ? '—' : money(positionTotal(p))}</span>
              </div>
              <Labeled label="Kategorie">
                <button
                  type="button"
                  disabled={moving}
                  onClick={() => {
                    setMoving(true)
                    onMoveCategory()
                    setTimeout(() => setMoving(false), 300)
                  }}
                  aria-label={`Category: ${p.category}. Change category`}
                  className="flex h-9 w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-left text-xs text-slate-800 shadow-xs transition-colors hover:border-brand-500 hover:bg-brand-50/40"
                >
                  <Icon name="folder_open" size={16} className="text-slate-400" />
                  <span className="shrink-0 font-mono text-[11px] text-slate-400">{leaf?.oz}</span>
                  <span className="min-w-0 flex-1 truncate">{p.category}</span>
                  <Icon name="drive_file_move" size={16} className="text-slate-400" />
                </button>
                {p.path && p.path.length > 1 && <span className="block truncate text-[11px] text-slate-400">{p.path.map((r) => r.label).join(' › ')}</span>}
              </Labeled>
              <Labeled label="Langtext">
                <textarea
                  key={`l-${p.long ?? ''}`}
                  aria-label="Langtext"
                  rows={12}
                  className={`${inputCls} h-auto resize-y py-2 leading-relaxed`}
                  defaultValue={p.long ?? ''}
                  placeholder="Kein Langtext vorhanden."
                  onBlur={(e) => e.target.value !== (p.long ?? '') && onPatch({ long: e.target.value })}
                />
              </Labeled>
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-5 py-3">
              <span className="text-[11px] text-slate-400">Changes are saved in this browser.</span>
              <button
                type="button"
                disabled={!edited}
                onClick={onReset}
                className="flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 shadow-xs transition-colors hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-40"
              >
                <Icon name="restart_alt" size={15} />
                Reset changes
              </button>
            </div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
