import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Button, Icon, IconButton, Menu, inputCls, useInertRoot } from './ui'
import { amount, budgetStatus, money, nbHyphen, parseNumber, qty } from '../lib/format'
import { statusText } from './Kit'
import { positionTotal } from '../lib/money'
import type { Position } from '../lib/types'

const parseNum = (s: string) => parseNumber(s) ?? NaN
/** GAEB long texts arrive hard-wrapped; join single line breaks, keep paragraphs */
const reflow = (t: string) => t.replace(/\r/g, '').split(/\n{2,}/).map((para) => para.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean)

function Labeled({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block space-y-1.5 ${className ?? ''}`}>
      <span className="text-sm font-medium text-slate-700">{label}</span>
      {children}
    </label>
  )
}

export function DetailDrawer({
  p, onClose, edited, added, onPatch, onQty, onUp, onReset, onMoveCategory, onRemove, onPrev, onNext, position, listTotal, cap,
}: {
  onRemove?: () => void
  /** live list total and cap, so a price change shows its effect on the budget */
  listTotal?: number
  cap?: number | null
  p: Position | null
  onClose: () => void
  edited: boolean
  added: boolean
  onPatch: (patch: Partial<Pick<Position, 'short' | 'long' | 'unit'>>) => void
  onQty: (n: number) => void
  onUp: (n: number | null) => void
  onReset: () => void
  onMoveCategory: () => void
  onPrev?: () => void
  onNext?: () => void
  /** "12 of 197" */
  position?: string
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const asideRef = useRef<HTMLElement>(null)
  const [moving, setMoving] = useState(false)
  const [editLongId, setEditLongId] = useState<string | null>(null)
  const [saved, setSaved] = useState('')
  const open = !!p
  useInertRoot(open)
  const editLong = !!p && editLongId === p.id
  const didSave = () => {
    setSaved('')
    requestAnimationFrame(() => setSaved('Saved'))
  }
  // keep Tab inside the drawer while it is open
  const trap = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !asideRef.current) return
    const els = [...asideRef.current.querySelectorAll<HTMLElement>('button:not([disabled]),input,textarea,a[href],[tabindex]:not([tabindex="-1"])')]
    if (!els.length) return
    const first = els[0], last = els[els.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => prev?.focus?.()
  }, [open])
  useEffect(() => {
    if (!p) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('[role=dialog][aria-labelledby]:not([aria-label]),[role=menu]') && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p?.id, onClose]) // eslint-disable-line react-hooks/exhaustive-deps

  const leaf = p?.path?.[p.path.length - 1]
  const upStr = (v: number | null) => (v == null ? '' : amount(v))
  const st = listTotal != null && cap ? budgetStatus(listTotal, cap) : null

  return createPortal(
    <AnimatePresence>
      {p && (
        <div className="fixed inset-0 z-[75]">
          <motion.div className="absolute inset-0 bg-slate-900/30" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} onClick={onClose} />
          <motion.aside
            ref={asideRef}
            onKeyDown={trap}
            role="dialog"
            aria-modal="true"
            aria-label={`Position ${p.oz}`}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%', transition: { duration: 0.16 } }}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
            className="absolute top-0 right-0 flex h-full w-full max-w-lg flex-col bg-white shadow-2xl sm:rounded-l-3xl"
          >
            <div className="flex items-center gap-1 px-4 pt-4 sm:px-6">
              <IconButton ref={closeRef} icon="close" label="Close details" onClick={onClose} className="size-10 -ml-2" size={22} />
              <span className="num ml-auto text-sm text-slate-600">{position}</span>
              <IconButton icon="keyboard_arrow_up" label="Previous position" onClick={onPrev} disabled={!onPrev} className="size-10 disabled:opacity-30" size={22} />
              <IconButton icon="keyboard_arrow_down" label="Next position" onClick={onNext} disabled={!onNext} className="size-10 disabled:opacity-30" size={22} />
              <Menu
                label={`Options for position ${p.oz}`}
                width="w-60"
                items={[
                  { label: 'Move to category…', icon: 'drive_file_move', onSelect: onMoveCategory },
                  { label: 'Undo my changes', icon: 'restart_alt', disabled: !edited, onSelect: onReset },
                  ...(onRemove ? ['sep' as const, { label: 'Remove position', icon: 'delete', danger: true, onSelect: onRemove }] : []),
                ]}
                trigger={(t) => (
                  <button {...t} type="button" aria-label={`Options for position ${p.oz}`} title="More options" className="flex size-10 items-center justify-center rounded-full text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900">
                    <Icon name="more_horiz" size={22} />
                  </button>
                )}
              />
            </div>
            <div className="flex-1 space-y-5 overflow-y-auto px-5 pt-3 pb-6 sm:px-6" key={p.id}>
              <div>
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <span className="num">OZ {p.oz}</span>
                  {edited && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700" data-testid="edited-badge">Edited</span>}
                  {added && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800">Added by you</span>}
                </div>
                {/* the title is the Kurztext field itself: reads as a heading, edits in place */}
                <h2 className="mt-1">
                  <textarea
                    key={`s-${p.short}`}
                    aria-label="Kurztext"
                    rows={1}
                    maxLength={300}
                    placeholder="(ohne Kurztext)"
                    defaultValue={p.short === '(ohne Kurztext)' ? '' : nbHyphen(p.short)}
                    onBlur={(e) => {
                      const v = e.target.value.replace(/\u2011/g, '-').replace(/\s+/g, ' ').trim()
                      if (v !== p.short && !(v === '' && p.short === '(ohne Kurztext)')) { onPatch({ short: v }); didSave() }
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
                    className="-mx-2 block w-[calc(100%+1rem)] resize-none rounded-xl border border-transparent bg-transparent px-2 py-1 font-heading text-xl leading-snug font-bold tracking-tight text-slate-900 transition-colors outline-none [field-sizing:content] placeholder:font-normal placeholder:text-slate-500 placeholder:italic hover:border-slate-300 focus:border-brand-600 focus:bg-white focus:ring-1 focus:ring-brand-600"
                  />
                </h2>
              </div>
              <div className="rounded-3xl bg-slate-50 px-5 py-4">
                <div className="text-sm font-medium text-slate-600">Gesamtpreis (GP)</div>
                <div className="num mt-0.5 text-[30px] leading-tight font-semibold tracking-tight text-slate-900">{p.up == null ? 'Not priced yet' : money(positionTotal(p))}</div>
                <div className="num mt-1 text-sm text-slate-600">{qty(p.qty)} {p.unit} × {p.up == null ? 'no unit price' : money(p.up)}</div>
                {listTotal != null && (
                  <div className="num mt-3 flex flex-wrap items-center gap-x-1.5 border-t border-slate-200 pt-3 text-sm text-slate-600">
                    <span>List total</span>
                    <span className="font-semibold text-slate-900">{money(listTotal)}</span>
                    {st && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{Math.round(st.pct)}% of cap</span>
                        <span aria-hidden>·</span>
                        <span className={`font-semibold ${statusText[st.tone]}`}>{st.word}</span>
                      </>
                    )}
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_0.8fr_1.3fr]">
                <Labeled label="Menge">
                  <input
                    key={`q-${p.qty}`}
                    aria-label="Menge"
                    inputMode="decimal"
                    className={`${inputCls} num text-right`}
                    defaultValue={qty(p.qty)}
                    onBlur={(e) => {
                      const n = parseNum(e.target.value)
                      if (Number.isFinite(n) && n >= 0 && n !== p.qty) { onQty(Math.round(n * 1000) / 1000); didSave() }
                      else e.target.value = qty(p.qty)
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  />
                </Labeled>
                <Labeled label="Einheit">
                  <input key={`u-${p.unit}`} aria-label="Einheit" className={inputCls} defaultValue={p.unit} onBlur={(e) => { if (e.target.value.trim() !== p.unit) { onPatch({ unit: e.target.value.trim() }); didSave() } }} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} maxLength={12} />
                </Labeled>
                <Labeled label="Einheitspreis (EP)" className="col-span-2 sm:col-span-1">
                  <span className="relative block">
                    <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-slate-500">€</span>
                    <input
                      key={`e-${p.up}`}
                      aria-label="Einheitspreis"
                      inputMode="decimal"
                      className={`${inputCls} num pl-7 text-right`}
                      defaultValue={upStr(p.up)}
                      placeholder="Not priced"
                      onBlur={(e) => {
                        const t = e.target.value.trim()
                        if (t === '') { if (p.up !== null) { onUp(null); didSave() } return }
                        const n = parseNum(t)
                        if (Number.isFinite(n) && n >= 0 && Math.round(n * 100) / 100 !== p.up) { onUp(Math.round(n * 100) / 100); didSave() }
                        else e.target.value = upStr(p.up)
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                    />
                  </span>
                </Labeled>
              </div>
              <div className="space-y-1.5">
                <span className="block text-sm font-medium text-slate-700">Kategorie</span>
                <button
                  type="button"
                  disabled={moving}
                  onClick={() => {
                    setMoving(true)
                    onMoveCategory()
                    setTimeout(() => setMoving(false), 300)
                  }}
                  aria-label={`Category: ${p.category}. Change category`}
                  className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-left text-sm text-slate-900 transition-colors hover:border-brand-600"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{leaf?.oz ? <span className="num text-slate-600">{leaf.oz} </span> : null}{p.category}</span>
                    {p.path && p.path.length > 1 && <span className="block truncate text-[13px] text-slate-600">{p.path.slice(0, -1).map((r) => r.label).join(' › ')}</span>}
                  </span>
                  <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-800">Change</span>
                </button>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span id="langtext-label" className="text-sm font-medium text-slate-700">Langtext</span>
                  <button type="button" onClick={() => setEditLongId(editLong ? null : p.id)} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-slate-100 px-3.5 text-sm font-semibold text-slate-800 transition-colors hover:bg-slate-200">
                    <Icon name={editLong ? 'check' : 'edit'} size={16} />
                    {editLong ? 'Done editing' : p.long ? 'Edit' : 'Add text'}
                  </button>
                </div>
                {editLong ? (
                  <textarea
                    aria-labelledby="langtext-label"
                    rows={10}
                    autoFocus
                    className={`${inputCls} h-auto resize-y py-2.5 leading-relaxed`}
                    defaultValue={p.long ?? ''}
                    onBlur={(e) => { if (e.target.value !== (p.long ?? '')) { onPatch({ long: e.target.value }); didSave() } }}
                  />
                ) : p.long?.trim() ? (
                  <div className="space-y-3 text-[15px] leading-relaxed text-pretty text-slate-800">
                    {reflow(p.long).map((para, i) => <p key={i}>{para}</p>)}
                  </div>
                ) : (
                  <p className="text-sm text-slate-600">No long text.</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 border-t border-slate-100 px-5 py-4 sm:px-6">
              {edited ? (
                <Button size="lg" variant="ghost" icon="restart_alt" onClick={onReset}>Undo my changes</Button>
              ) : (
                <span className="flex items-center gap-1.5 text-sm text-slate-600"><Icon name="check_circle" size={18} className="text-emerald-600" />Changes save automatically</span>
              )}
              <span role="status" aria-live="polite" className="ml-auto text-sm font-medium text-emerald-700">{saved}</span>
            </div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
