import { clsx } from 'clsx'
import {
  type ButtonHTMLAttributes, type ReactNode, type Ref, useEffect, useId, useLayoutEffect, useRef, useState,
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { create } from 'zustand'
import { pct } from '../lib/format'

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
  primary: 'bg-brand-600 hover:bg-brand-700 text-white font-semibold shadow-sm shadow-brand-600/20',
  secondary: 'bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 text-slate-700 font-medium shadow-xs',
  ghost: 'text-slate-500 hover:text-slate-800 hover:bg-slate-100 font-medium',
  danger: 'bg-rose-600 hover:bg-rose-700 text-white font-semibold shadow-sm',
  soft: 'bg-brand-50 text-brand-700 hover:bg-brand-100 font-semibold border border-brand-600/20',
}
const sizes: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-8 px-3 text-xs gap-1.5 rounded-lg',
  lg: 'h-9 px-3.5 text-xs gap-1.5 rounded-lg',
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
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 16} className={iconClass} />}
      {children}
    </button>
  )
}

export function IconButton({
  icon, label, className, size = 16, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; size?: number; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex size-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 active:scale-[0.94]',
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
  warn: 'bg-red-500',
  over: 'bg-red-500',
  brand: 'bg-brand-600',
}

export function Meter({ value, tone, height = 'h-3.5', className, label }: { value: number; tone: string; height?: string; className?: string; label?: string }) {
  const w = Math.max(0, Math.min(100, value))
  const tiny = w < 14
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      aria-label={label ?? 'Budget used'}
      className={clsx('relative flex flex-1 items-center overflow-hidden rounded-full bg-slate-100 p-0.5', height, className)}
    >
      <motion.div
        className={clsx('flex h-full items-center justify-center rounded-full shadow-xs', toneBar[tone])}
        initial={false}
        animate={{ width: value > 0 ? `${Math.max(w, 4)}%` : 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 32 }}
      >
        {!tiny && <span className="font-mono text-[10px] font-semibold tracking-tight text-white">{pct(value)}</span>}
      </motion.div>
      {tiny && (
        <span className={clsx('absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 font-mono text-[10px] font-semibold tracking-tight', tone === 'ok' ? 'text-emerald-600' : 'text-slate-500')}>
          {pct(value)}
        </span>
      )}
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
              className={clsx('z-[70] rounded-xl border border-slate-200 bg-white p-1 shadow-[0_4px_20px_-2px_rgba(15,23,42,0.08)]', width)}
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
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium outline-none transition-colors disabled:opacity-40',
                      it.danger ? 'text-rose-600 hover:bg-rose-50 focus-visible:bg-rose-50' : 'text-slate-700 hover:bg-slate-100 focus-visible:bg-slate-100',
                    )}
                  >
                    {it.icon && <Icon name={it.icon} size={16} className={it.danger ? 'text-rose-500' : 'text-slate-400'} />}
                    <span className="flex-1 truncate">{it.label}</span>
                    {it.hint && <kbd className="font-mono text-[10px] text-slate-400">{it.hint}</kbd>}
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
              'relative w-full rounded-t-2xl border border-slate-200 bg-white shadow-[0_16px_32px_-4px_rgba(15,23,42,0.08)] sm:rounded-xl',
              width,
            )}
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
              <div className="min-w-0">
                <h2 id={titleId} className="font-heading text-base font-bold tracking-tight text-slate-900">{title}</h2>
                {description && <div className="mt-0.5 text-xs text-slate-500">{description}</div>}
              </div>
              <IconButton icon="close" label="Close dialog" onClick={onClose} className="-mr-1.5" />
            </div>
            <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
            {footer && <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</div>}
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
      <span className="text-xs font-semibold text-slate-700">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-400">{hint}</span>}
    </label>
  )
}

export const inputCls =
  'w-full h-9 px-3 rounded-lg bg-white border border-slate-200 text-slate-800 placeholder:text-slate-400 text-xs outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-[border-color,box-shadow] shadow-xs'

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

interface Toast { id: number; text: string; tone: 'ok' | 'info' | 'error'; action?: { label: string; run: () => void } }
const useToasts = create<{ toasts: Toast[]; push: (t: Omit<Toast, 'id'>) => void; drop: (id: number) => void }>((set) => ({
  toasts: [],
  push: (t) => {
    const id = Date.now() + Math.random()
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), 4200)
  },
  drop: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}))

export const toast = (text: string, tone: Toast['tone'] = 'ok', action?: Toast['action']) =>
  useToasts.getState().push({ text, tone, action })

export function Toaster() {
  const { toasts, drop } = useToasts()
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[90] flex w-[calc(100%-2rem)] max-w-sm flex-col items-end gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 24, transition: { duration: 0.15 } }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="pointer-events-auto flex w-full items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs text-slate-700 shadow-lg shadow-slate-900/5"
          >
            <Icon
              name={t.tone === 'error' ? 'error' : t.tone === 'info' ? 'info' : 'check_circle'}
              size={17}
              className={t.tone === 'error' ? 'text-rose-500' : t.tone === 'info' ? 'text-brand-600' : 'text-emerald-500'}
            />
            <span className="flex-1 font-medium">{t.text}</span>
            {t.action && (
              <button type="button" className="font-semibold text-brand-600 hover:text-brand-700" onClick={() => { t.action!.run(); drop(t.id) }}>
                {t.action.label}
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
