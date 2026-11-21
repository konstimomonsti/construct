import { clsx } from 'clsx'
import {
  type ButtonHTMLAttributes, type ReactNode, type Ref, useEffect, useId, useLayoutEffect, useRef, useState,
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { create } from 'zustand'

/* ------------------------------------------------------------------ */
/* Icon                                                                */
/* ------------------------------------------------------------------ */

export function Icon({ name, size = 18, className, fill }: { name: string; size?: number; className?: string; fill?: boolean }) {
  return (
    <span aria-hidden className={clsx('ms', fill && 'ms-fill', className)} style={{ fontSize: size, width: size, height: size }}>
      {name}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft'
type Size = 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  primary: 'bg-brand-600 hover:bg-brand-700 text-white font-semibold',
  secondary: 'bg-slate-100 hover:bg-slate-200 text-slate-900 font-semibold ring-1 ring-inset ring-slate-300',
  ghost: 'text-slate-700 hover:text-slate-900 hover:bg-slate-100 font-medium',
  danger: 'bg-rose-600 hover:bg-rose-700 text-white font-semibold',
  soft: 'bg-brand-50 text-brand-700 hover:bg-brand-100 font-semibold',
}
const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-full',
  md: 'h-9 px-4 text-sm gap-1.5 rounded-full',
  lg: 'h-10 px-5 text-sm gap-2 rounded-full',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: string
  iconClass?: string
  ref?: Ref<HTMLButtonElement>
}

export function Button({ variant = 'secondary', size = 'md', icon, iconClass, className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-[background-color,border-color,color,box-shadow,transform] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 16 : 18} className={iconClass} />}
      {children}
    </button>
  )
}

export function IconButton({
  icon, label, className, size = 18, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; size?: number; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex size-9 items-center justify-center rounded-full text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 active:scale-[0.94]',
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Budget meter (pill track with inline % label)                       */
/* ------------------------------------------------------------------ */

export const toneBar: Record<string, string> = {
  ok: 'bg-emerald-500',
  caution: 'bg-amber-500',
  warn: 'bg-orange-500',
  over: 'bg-rose-600',
  brand: 'bg-brand-600',
  none: 'bg-slate-300',
}

/** slim progress track; the value is always printed next to it as text by the caller */
export function Meter({ value, tone, height = 'h-1.5', className, label }: { value: number; tone: string; height?: string; className?: string; label?: string }) {
  const w = Math.max(0, Math.min(100, value))
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(w)}
      aria-valuetext={`${Math.round(value)}%`}
      aria-label={label ?? 'Budget used'}
      className={clsx('relative flex-1 overflow-hidden rounded-full bg-slate-300', height, className)}
    >
      <motion.div
        className={clsx('h-full rounded-full', toneBar[tone] ?? toneBar.brand)}
        initial={false}
        animate={{ width: value > 0 ? `${Math.max(w, 1.5)}%` : 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 32 }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Popover menu (keyboard accessible)                                  */
/* ------------------------------------------------------------------ */

export interface MenuItem {
  label: string
  icon?: string
  onSelect: () => void
  danger?: boolean
  checked?: boolean
  hint?: string
  disabled?: boolean
}

export function Menu({
  trigger, items, align = 'end', label, width = 'w-52',
}: {
  trigger: (props: { ref: Ref<HTMLButtonElement>; onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu'; 'aria-controls': string }) => ReactNode
  items: (MenuItem | 'sep')[]
  align?: 'start' | 'end'
  label: string
  width?: string
}) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean }>({ top: 0, left: 0, up: false })

  useLayoutEffect(() => {
    if (!open || !btn.current) return
    const r = btn.current.getBoundingClientRect()
    const up = r.bottom + 260 > window.innerHeight && r.top > 260
    setPos({ top: up ? r.top - 6 : r.bottom + 6, left: align === 'end' ? r.right : r.left, up })
  }, [open, align])

  useEffect(() => {
    if (!open) return
    const first = menu.current?.querySelector<HTMLButtonElement>('[role=menuitem]:not([disabled]),[role=menuitemcheckbox]')
    first?.focus()
    const onDown = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false)
    }
    const onScroll = () => setOpen(false)
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  const onKey = (e: React.KeyboardEvent) => {
    const els = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role^=menuitem]:not([disabled])') ?? [])]
    const i = els.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length]?.focus() }
    if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus() }
    if (e.key === 'Home') { e.preventDefault(); els[0]?.focus() }
    if (e.key === 'End') { e.preventDefault(); els[els.length - 1]?.focus() }
    if (e.key === 'Escape' || e.key === 'Tab') { setOpen(false); btn.current?.focus() }
  }

  return (
    <>
      {trigger({ ref: btn, onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'menu', 'aria-controls': id })}
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={menu}
              id={id}
              role="menu"
              aria-label={label}
              onKeyDown={onKey}
              initial={{ opacity: 0, scale: 0.96, y: pos.up ? 4 : -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
              style={{
                position: 'fixed',
                top: pos.top,
                left: pos.left,
                translate: `${align === 'end' ? '-100%' : '0'} ${pos.up ? '-100%' : '0'}`,
                transformOrigin: `${align === 'end' ? 'right' : 'left'} ${pos.up ? 'bottom' : 'top'}`,
              }}
              className={clsx('z-[85] rounded-2xl border border-slate-200/70 bg-white p-1.5 shadow-[0_12px_32px_-8px_rgba(15,23,42,0.18)]', width)}
            >
              {items.map((it, i) =>
                it === 'sep' ? (
                  <div key={`s${i}`} role="separator" className="my-1 h-px bg-slate-100" />
                ) : (
                  <button
                    key={it.label}
                    type="button"
                    role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
                    aria-checked={it.checked}
                    disabled={it.disabled}
                    onClick={() => { setOpen(false); it.onSelect() }}
                    className={clsx(
                      'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-medium outline-none transition-colors disabled:opacity-40',
                      it.danger ? 'text-rose-600 hover:bg-rose-50 focus-visible:bg-rose-50 focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-inset' : 'text-slate-700 hover:bg-slate-100 focus-visible:bg-brand-50 focus-visible:text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-inset',
                    )}
                  >
                    {it.icon && <Icon name={it.icon} size={18} className={it.danger ? 'text-rose-600' : 'text-slate-600'} />}
                    <span className="flex-1 truncate">{it.label}</span>
                    {it.hint && <kbd className="text-xs text-slate-500">{it.hint}</kbd>}
                    {it.checked && <Icon name="check" size={15} className="text-brand-600" />}
                  </button>
                ),
              )}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

export function Dialog({
  open, onClose, title, description, children, width = 'max-w-md', footer,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  children?: ReactNode
  width?: string
  footer?: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useInertRoot(open)
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const t = setTimeout(() => {
      const el = panel.current?.querySelector<HTMLElement>('[data-autofocus], input, textarea, select, button')
      el?.focus()
    }, 30)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Tab' && panel.current) {
        const f = [...panel.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'))
        if (!f.length) return
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus() }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus() }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [open, onClose])

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center p-0 sm:items-center sm:p-4">
          <motion.div
            className="absolute inset-0 bg-slate-900/25 backdrop-blur-[4px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
          />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 4, transition: { duration: 0.12 } }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className={clsx(
              'relative w-full rounded-t-3xl bg-white shadow-[0_24px_48px_-12px_rgba(15,23,42,0.25)] sm:rounded-3xl',
              width,
            )}
          >
            <div className="flex items-start justify-between gap-3 px-6 pt-6 pb-2">
              <div className="min-w-0">
                <h2 id={titleId} className="font-heading text-lg font-bold tracking-tight text-slate-900">{title}</h2>
                {description && <div className="mt-1 text-sm text-slate-600">{description}</div>}
              </div>
              <IconButton icon="close" label="Close dialog" onClick={onClose} className="-mr-1.5" />
            </div>
            <div className="max-h-[70vh] overflow-y-auto px-6 py-4">{children}</div>
            {footer && <div className="flex items-center justify-end gap-2 px-6 pt-2 pb-6">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-semibold text-slate-800">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-600">{hint}</span>}
    </label>
  )
}

export const inputCls =
  'w-full h-10 px-3.5 rounded-xl bg-white border border-slate-400 text-slate-900 placeholder:text-slate-500 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20 transition-[border-color,box-shadow]'

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

interface Toast { id: number; text: string; tone: 'ok' | 'info' | 'error'; action?: { label: string; run: () => void } }
const useToasts = create<{ toasts: Toast[]; push: (t: Omit<Toast, 'id'>) => void; drop: (id: number) => void }>((set) => ({
  toasts: [],
  push: (t) => set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id: Date.now() + Math.random() }] })),
  drop: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}))

/** one toast; its timer pauses while hovered or focused, and runs longer when it offers an action */
function ToastItem({ t, drop }: { t: Toast; drop: (id: number) => void }) {
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    if (paused) return
    const h = setTimeout(() => drop(t.id), t.action ? 10000 : 5000)
    return () => clearTimeout(h)
  }, [paused, t.id, t.action, drop])
  return (
    <motion.div
      layout
      role={t.tone === 'error' ? 'alert' : 'status'}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.15 } }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className="pointer-events-auto flex w-full items-center gap-2.5 rounded-2xl bg-slate-900 py-2 pr-2 pl-4 text-sm text-white shadow-lg shadow-slate-900/20"
    >
      <Icon
        name={t.tone === 'error' ? 'error' : t.tone === 'info' ? 'info' : 'check_circle'}
        size={17}
        className={t.tone === 'error' ? 'text-rose-400' : t.tone === 'info' ? 'text-brand-300' : 'text-emerald-400'}
      />
      <span className="flex-1 py-1.5 font-medium">{t.text}</span>
      {t.action && (
        <button type="button" className="h-9 rounded-full px-3 font-semibold text-brand-200 hover:bg-white/10" onClick={() => { t.action!.run(); drop(t.id) }}>
          {t.action.label}
        </button>
      )}
      <button type="button" aria-label="Dismiss" onClick={() => drop(t.id)} className="flex size-9 items-center justify-center rounded-full text-slate-300 hover:bg-white/10 hover:text-white">
        <Icon name="close" size={18} />
      </button>
    </motion.div>
  )
}

export const toast = (text: string, tone: Toast['tone'] = 'ok', action?: Toast['action']) =>
  useToasts.getState().push({ text, tone, action })

/** while a drawer or panel is open, the app behind it is hidden from keyboard and screen readers */
export function useInertRoot(active: boolean) {
  useEffect(() => {
    const root = document.getElementById('root')
    if (!active || !root) return
    root.inert = true
    return () => { root.inert = false }
  }, [active])
}

/* portaled so toasts (and their Undo) stay usable while the app behind a drawer is inert */
export function Toaster() {
  const { toasts, drop } = useToasts()
  return createPortal(
    <div className="pointer-events-none fixed right-4 bottom-24 z-[90] flex w-[calc(100%-2rem)] max-w-sm flex-col items-end gap-2 sm:bottom-20">
      <AnimatePresence initial={false}>
        {toasts.map((t) => <ToastItem key={t.id} t={t} drop={drop} />)}
      </AnimatePresence>
    </div>,
    document.body,
  )
}
