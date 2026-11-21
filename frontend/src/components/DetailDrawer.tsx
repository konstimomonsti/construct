import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Button, Icon, Menu, useInertRoot } from './ui'
import { LOCALE, amount, budgetStatus, money, nbHyphen, parseNumber, qty } from '../lib/format'
import { statusText } from './Kit'
import { positionTotal } from '../lib/money'
import type { CategoryRef, Position } from '../lib/types'

const parseNum = (s: string) => parseNumber(s) ?? NaN
/** GAEB long texts arrive hard-wrapped; join single line breaks, keep paragraphs */
const reflow = (t: string) => t.replace(/\r/g, '').split(/\n{2,}/).map((para) => para.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean)
/** "Baustelleneinrichtung - Montagepläne - I" → "Baustelleneinrichtung - Montagepläne" (a dangling one-letter segment reads like a cut-off string) */
const cleanLabel = (s: string) => s.replace(/(?:\s+[-–—]\s*\p{L}\.?)+$/u, '').trim() || s
const pctFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 })
const sharePct = (v: number) => (v > 0 && v < 0.05 ? `< ${pctFmt.format(0.1)}%` : `${pctFmt.format(v)}%`)

/* text fields: white with a ≥3:1 slate-500 boundary and a brand focus ring (no padding/height, so callers never stack conflicting classes) */
const fieldCls =
  'w-full rounded-xl border border-slate-500 bg-white text-sm text-slate-900 outline-none transition-[border-color,box-shadow] placeholder:text-slate-500 hover:border-slate-600 focus:border-brand-700 focus:ring-2 focus:ring-brand-700/25'
/* header icon buttons: 44px hit area on the phone sheet, 40px on desktop */
const headBtn =
  'inline-flex size-11 shrink-0 items-center justify-center rounded-md text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 active:scale-[0.94] disabled:pointer-events-none disabled:opacity-30 sm:size-10'
/* hover pencil cue shared by Kurztext and Langtext (always visible on touch) */
const pencilCls = 'opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100'

/* below sm the drawer is a bottom sheet, so the entry animation needs to know the breakpoint */
const SM = '(min-width: 640px)'
const subscribeSm = (cb: () => void) => {
  const mq = window.matchMedia(SM)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}
const useIsDesktop = () => useSyncExternalStore(subscribeSm, () => window.matchMedia(SM).matches, () => true)

function Labeled({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block space-y-1.5 ${className ?? ''}`}>
      <span className="block text-[13px] font-semibold text-slate-600">{label}</span>
      {children}
    </label>
  )
}

export function DetailDrawer({
  p, catalogue, onClose, edited, added, onPatch, onQty, onUp, onReset, onMoveCategory, onRemove, onPrev, onNext, position, listTotal, cap, imported,
}: {
  onRemove?: () => void
  /** live list total and cap, so a price change shows its effect on the budget */
  listTotal?: number
  cap?: number | null
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
  onPrev?: () => void
  onNext?: () => void
  /** "12 of 197" */
  position?: string
  /** the position as it was imported (before the user's edits), to compare Menge / EP against; omit for positions the user added */
  imported?: Pick<Position, 'qty' | 'unit' | 'up'> | null
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const asideRef = useRef<HTMLElement>(null)
  const uid = useId()
  const isDesktop = useIsDesktop()
  const [moving, setMoving] = useState(false)
  const [editLongId, setEditLongId] = useState<string | null>(null)
  const [editUnitId, setEditUnitId] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState(0)
  const open = !!p
  useInertRoot(open)
  const editLong = !!p && editLongId === p.id
  const editUnit = !!p && editUnitId === p.id
  const didSave = () => {
    setSavedAt(0)
    requestAnimationFrame(() => setSavedAt(Date.now()))
  }
  // "Saved" replaces the helper text for two seconds, where the eye already is
  useEffect(() => {
    if (!savedAt) return
    const t = setTimeout(() => setSavedAt(0), 2000)
    return () => clearTimeout(t)
  }, [savedAt])
  // keep Tab inside the drawer while it is open
  const trap = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !asideRef.current) return
    const els = [...asideRef.current.querySelectorAll<HTMLElement>('button:not([disabled]),input,textarea,a[href],[tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null)
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

  const upStr = (v: number | null) => (v == null ? '' : amount(v))
  const st = listTotal != null && cap ? budgetStatus(listTotal, cap) : null

  const total = p ? positionTotal(p) : 0
  const share = p && p.up != null && listTotal ? (total / listTotal) * 100 : null
  const headroom = listTotal != null && cap ? cap - listTotal : null
  const changed = !!p && !!imported && (imported.qty !== p.qty || imported.up !== p.up)
  const delta = changed && p && imported ? total - positionTotal(imported) : 0

  // Kategorie: parent chain as a breadcrumb above the leaf
  const path: CategoryRef[] = p?.path?.length ? p.path : p ? [{ oz: '', label: p.category }] : []
  const leaf = path[path.length - 1]
  const leafLabel = cleanLabel(leaf?.label ?? '')
  const parents = path.slice(0, -1).map((r) => ({ oz: r.oz, label: cleanLabel(r.label) }))
  const crumbTitle = [...parents, { oz: leaf?.oz ?? '', label: leafLabel }].map((r) => `${r.oz} ${r.label}`.trim()).join(' › ')

  const navCounter = (cls: string) => position ? <span aria-live="polite" aria-atomic="true" className={`num text-sm text-slate-600 ${cls}`}>{position}</span> : null

  return createPortal(
    <AnimatePresence>
      {p && (
        <div className="fixed inset-0 z-[75]">
          <motion.div className="absolute inset-0 bg-black/60" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} onClick={onClose} />
          <motion.aside
            ref={asideRef}
            onKeyDown={trap}
            role="dialog"
            aria-modal="true"
            aria-label={`Position ${p.oz}`}
            initial={isDesktop ? { x: '100%' } : { y: '100%' }}
            animate={isDesktop ? { x: 0 } : { y: 0 }}
            exit={{ ...(isDesktop ? { x: '100%' } : { y: '100%' }), transition: { duration: 0.16 } }}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-x-0 bottom-0 flex max-h-[90dvh] w-full flex-col rounded-t-3xl bg-white shadow-2xl ring-1 ring-slate-200 sm:top-0 sm:left-auto sm:h-full sm:max-h-none sm:max-w-lg sm:rounded-tr-none sm:rounded-bl-3xl"
          >
            <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-slate-300 sm:hidden" />
            <div className="flex shrink-0 items-center gap-1 px-4 pt-2 sm:px-6 sm:pt-4">
              <button ref={closeRef} type="button" aria-label="Close details" title="Close details" onClick={onClose} className={`${headBtn} -ml-2`}>
                <Icon name="close" size={22} />
              </button>
              <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
                {navCounter('px-1')}
                <button type="button" aria-label="Previous position" title="Previous position" onClick={onPrev} disabled={!onPrev} className={headBtn}>
                  <Icon name="keyboard_arrow_up" size={22} />
                </button>
                <button type="button" aria-label="Next position" title="Next position" onClick={onNext} disabled={!onNext} className={headBtn}>
                  <Icon name="keyboard_arrow_down" size={22} />
                </button>
              </div>
              <Menu
                label={`Options for position ${p.oz}`}
                width="w-60"
                items={[
                  { label: 'Change unit…', icon: 'straighten', onSelect: () => setEditUnitId(p.id) },
                  { label: 'Move to category…', icon: 'drive_file_move', onSelect: onMoveCategory },
                  { label: 'Undo my changes', icon: 'restart_alt', disabled: !edited, onSelect: onReset },
                  ...(onRemove ? ['sep' as const, { label: 'Remove position', icon: 'delete', danger: true, onSelect: onRemove }] : []),
                ]}
                trigger={(t) => (
                  <button {...t} type="button" aria-label={`Options for position ${p.oz}`} title="More options" className={headBtn}>
                    <Icon name="more_horiz" size={22} />
                  </button>
                )}
              />
            </div>
            <div className="relative flex min-h-0 flex-auto flex-col">
              <div className="min-h-0 flex-auto space-y-5 overflow-y-auto px-5 pt-3 pb-6 sm:px-6" key={p.id}>
                {/* title line: OZ prefix · Kurztext (edits in place) · badges */}
                <div className="flex items-start gap-1.5">
                  <h2 className="sr-only">{`${p.oz} ${p.short}`}</h2>
                  <span aria-hidden className="num shrink-0 pt-1.5 text-base text-slate-600 tabular-nums">{p.oz}</span>
                  <div className="group relative min-w-0 flex-1">
                    <label htmlFor={`${uid}-short`} className="sr-only">Kurztext</label>
                    <textarea
                      id={`${uid}-short`}
                      key={`s-${p.short}`}
                      rows={1}
                      maxLength={300}
                      placeholder="(ohne Kurztext)"
                      defaultValue={p.short === '(ohne Kurztext)' ? '' : nbHyphen(p.short)}
                      onBlur={(e) => {
                        const v = e.target.value.replace(/‑/g, '-').replace(/\s+/g, ' ').trim()
                        if (v !== p.short && !(v === '' && p.short === '(ohne Kurztext)')) { onPatch({ short: v }); didSave() }
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
                      className="block w-full resize-none rounded-xl border border-transparent bg-transparent py-1 pr-8 pl-2 font-heading text-[22px] leading-7 font-semibold tracking-tight text-slate-900 transition-colors outline-none [field-sizing:content] placeholder:font-normal placeholder:text-slate-500 placeholder:italic hover:border-slate-400 focus:border-brand-600 focus:bg-white focus:ring-1 focus:ring-brand-600"
                    />
                    <Icon
                      name="edit"
                      size={16}
                      className={`pointer-events-none absolute top-2.5 right-2.5 text-slate-500 ${pencilCls}`}
                    />
                  </div>
                  {(edited || added) && (
                    <div className="flex shrink-0 flex-col items-end gap-1 pt-2">
                      {edited && <span className="rounded-md bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700" data-testid="edited-badge">Edited</span>}
                      {added && <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800">Added by you</span>}
                    </div>
                  )}
                </div>
                {catalogue}
                <div className="border-y border-slate-200 py-4">
                  <div className="text-sm font-medium text-slate-600">GP</div>
                  <div className="num display mt-1 text-[32px] leading-tight text-slate-900">{p.up == null ? 'Not priced yet' : money(total)}</div>
                  <div className="num mt-1 text-sm text-slate-600">{qty(p.qty)} {p.unit} × {p.up == null ? 'no unit price' : money(p.up)}</div>
                  {changed && delta !== 0 && (
                    <div className="num mt-1 text-sm font-medium text-slate-800">{delta > 0 ? '+' : ''}{money(delta)} vs. imported</div>
                  )}
                  {(share != null || headroom != null) && (
                    <div className="num mt-3 flex flex-wrap items-center gap-x-1.5 text-sm text-slate-600">
                      {share != null && <span>{sharePct(share)} of list</span>}
                      {share != null && headroom != null && <span aria-hidden>·</span>}
                      {headroom != null && st && (
                        headroom >= 0
                          ? <span className={st.tone === 'ok' ? '' : `font-semibold ${statusText[st.tone]}`}>{money(headroom)} left in cap</span>
                          : <span className={`font-semibold ${statusText.over}`}>{money(-headroom)} over cap</span>
                      )}
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label htmlFor={`${uid}-qty`} className="block text-[13px] font-semibold text-slate-600">Menge</label>
                      {/* Einheit sits inside the field as a suffix, like € in EP; it opens the unit editor */}
                      <span className="relative block">
                        <input
                          id={`${uid}-qty`}
                          key={`q-${p.qty}`}
                          inputMode="decimal"
                          aria-describedby={`${uid}-unit`}
                          className={`${fieldCls} num h-10 pl-3 text-right`}
                          style={{ paddingRight: editUnit ? '5.75rem' : `calc(${Math.min(Math.max((p.unit || '–').length, 1), 6)}ch + 2.25rem)` }}
                          defaultValue={qty(p.qty)}
                          onBlur={(e) => {
                            const n = parseNum(e.target.value)
                            if (Number.isFinite(n) && n >= 0 && n !== p.qty) { onQty(Math.round(n * 1000) / 1000); didSave() }
                            else e.target.value = qty(p.qty)
                          }}
                          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                        />
                        <span id={`${uid}-unit`} hidden>{`Einheit ${p.unit || '–'}`}</span>
                        {editUnit ? (
                          <>
                            <label htmlFor={`${uid}-unit-input`} className="sr-only">Einheit</label>
                            <input
                              id={`${uid}-unit-input`}
                              autoFocus
                              maxLength={12}
                              defaultValue={p.unit}
                              className="absolute top-1 right-1 bottom-1 w-20 rounded-lg border border-slate-500 bg-white px-2 text-sm text-slate-900 outline-none hover:border-slate-600 focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20"
                              onBlur={(e) => {
                                const v = e.target.value.trim()
                                if (v !== p.unit) { onPatch({ unit: v }); didSave() }
                                setEditUnitId(null)
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') e.currentTarget.blur()
                                if (e.key === 'Escape') { e.stopPropagation(); e.currentTarget.value = p.unit; e.currentTarget.blur() }
                              }}
                            />
                          </>
                        ) : (
                          <button
                            type="button"
                            title="Change Einheit"
                            onClick={() => setEditUnitId(p.id)}
                            className="absolute top-1 right-1 bottom-1 flex max-w-[50%] items-center gap-0.5 rounded-lg pr-1 pl-2 text-sm text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900"
                          >
                            <span className="sr-only">Einheit </span>
                            <span className="min-w-0 truncate">{p.unit || '–'}</span>
                            <Icon name="expand_more" size={16} className="shrink-0 text-slate-600" />
                          </button>
                        )}
                      </span>
                    </div>
                    <Labeled label="EP">
                      <span className="relative block">
                        <input
                          key={`e-${p.up}`}
                          inputMode="decimal"
                          className={`${fieldCls} num h-10 pr-8 pl-3 text-right`}
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
                        <span aria-hidden className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-slate-600">€</span>
                      </span>
                    </Labeled>
                  </div>
                  {changed && imported && (
                    <p className="num text-[13px] text-slate-600">
                      Imported: {qty(imported.qty)} {imported.unit} × {imported.up == null ? 'not priced' : money(imported.up)}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <span id={`${uid}-cat`} className="block text-[13px] font-semibold text-slate-600">Kategorie</span>
                  <button
                    id={`${uid}-cat-btn`}
                    type="button"
                    disabled={moving}
                    onClick={() => {
                      setMoving(true)
                      onMoveCategory()
                      setTimeout(() => setMoving(false), 300)
                    }}
                    aria-labelledby={`${uid}-cat ${uid}-cat-btn`}
                    title={crumbTitle}
                    className="flex min-h-11 w-full items-center gap-3 rounded-xl bg-slate-50 px-3.5 py-2 text-left text-sm text-slate-900 transition-colors hover:bg-slate-100"
                  >
                    <span className="min-w-0 flex-1">
                      {parents.length > 0 && (
                        <span className="line-clamp-2 text-[13px] text-slate-600">
                          {parents.map((r, i) => (
                            <span key={r.oz || i}>
                              {i > 0 && <span aria-hidden className="px-1 text-slate-500">›</span>}
                              <span className="num">{r.oz}</span>
                              {r.label && r.label !== leafLabel && <> {r.label}</>}
                            </span>
                          ))}
                          <span aria-hidden className="px-1 text-slate-500">›</span>
                        </span>
                      )}
                      <span className="line-clamp-2">{leaf?.oz ? <span className="num text-slate-600">{leaf.oz} </span> : null}{leafLabel}</span>
                    </span>
                    <span className="sr-only">. Change category</span>
                    <Icon name="chevron_right" size={20} className="shrink-0 text-slate-600" />
                  </button>
                </div>
                <div className="space-y-1.5">
                  <span id={`${uid}-long`} className="block text-[13px] font-semibold text-slate-600">Langtext</span>
                  {editLong ? (
                    <textarea
                      aria-labelledby={`${uid}-long`}
                      rows={10}
                      autoFocus
                      className={`${fieldCls} resize-y px-3.5 py-2.5 leading-relaxed`}
                      defaultValue={p.long ?? ''}
                      onBlur={(e) => {
                        if (e.target.value !== (p.long ?? '')) { onPatch({ long: e.target.value }); didSave() }
                        setEditLongId(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') { e.stopPropagation(); e.currentTarget.value = p.long ?? ''; e.currentTarget.blur() }
                      }}
                    />
                  ) : (
                    /* click-to-edit like Kurztext: the text itself opens the editor, the pencil button gives keyboard access */
                    <div
                      className="group relative -mx-2 cursor-text rounded-xl border border-transparent py-1 pr-10 pl-2 transition-colors hover:border-slate-400"
                      onClick={() => { if (!window.getSelection()?.toString()) setEditLongId(p.id) }}
                    >
                      {p.long?.trim() ? (
                        <div className="space-y-3 text-[15px] leading-relaxed text-pretty text-slate-800">
                          {reflow(p.long).map((para, i) => <p key={i}>{para}</p>)}
                        </div>
                      ) : (
                        <p className="text-sm leading-relaxed text-slate-600 italic">No long text. Click to add.</p>
                      )}
                      <button
                        type="button"
                        aria-label={p.long?.trim() ? 'Edit Langtext' : 'Add Langtext'}
                        title={p.long?.trim() ? 'Edit Langtext' : 'Add Langtext'}
                        onClick={(e) => { e.stopPropagation(); setEditLongId(p.id) }}
                        className={`absolute top-0.5 right-0.5 flex size-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:opacity-100 ${pencilCls}`}
                      >
                        <Icon name="edit" size={16} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {/* fade the scroll edge so text never stops mid-glyph at the footer */}
              <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-linear-to-t from-white to-transparent" />
            </div>
            <div className="shrink-0 border-t border-slate-100 px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-4">
              <div className="flex min-h-10 items-center gap-2">
                <span role="status" className="sr-only">{savedAt ? 'Saved' : ''}</span>
                {savedAt ? (
                  <span aria-hidden className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-emerald-700"><Icon name="check_circle" size={18} className="shrink-0 text-emerald-600" fill />Saved</span>
                ) : (
                  <span className="flex min-w-0 items-center gap-1.5 text-sm text-slate-600"><Icon name="check_circle" size={18} className="shrink-0 text-emerald-600" />Changes save automatically</span>
                )}
                {edited && <Button size="lg" variant="ghost" icon="restart_alt" onClick={onReset} className="ml-auto">Undo my changes</Button>}
              </div>
            </div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
