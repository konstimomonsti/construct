import { clsx } from 'clsx'
import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Icon, Menu, Meter, type MenuItem } from './ui'
import { Page } from './Page'
import { budgetStatus, moneyWhole } from '../lib/format'

/* ------------------------------------------------------------------ */
/* Page frame + header                                                 */
/* ------------------------------------------------------------------ */

/** every screen shares one column width so the eye never re-anchors between pages */
export function PageFrame({ children, className }: { children: ReactNode; className?: string; wide?: boolean }) {
  return (
    <Page className={clsx('mx-auto w-full max-w-[1120px] px-4 pt-5 pb-32 sm:px-8 sm:pt-8', className)}>
      {children}
    </Page>
  )
}

export interface Crumb { label: string; to: string }

export function Crumbs({ items }: { items: Crumb[] }) {
  if (!items.length) return null
  return (
    <nav aria-label="Breadcrumb" className="mb-1.5 flex min-w-0 items-center gap-1 overflow-hidden text-sm whitespace-nowrap text-slate-600">
      {items.map((c, i) => (
        <Fragment key={c.to + i}>
          {i > 0 && <Icon name="chevron_right" size={16} className="shrink-0 text-slate-400" />}
          <Link to={c.to} className="truncate rounded transition-colors hover:text-slate-900 hover:underline">{c.label}</Link>
        </Fragment>
      ))}
    </nav>
  )
}

export function PageHeader({
  crumbs = [], title, subtitle, icon, tone, aside,
}: {
  crumbs?: Crumb[]
  title: ReactNode
  subtitle?: ReactNode
  icon?: string
  tone?: string
  aside?: ReactNode
}) {
  return (
    <header className="mb-6">
      <Crumbs items={crumbs} />
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          {icon && <Avatar icon={icon} tone={tone} size="lg" />}
          <div className="min-w-0">
            <h1 className="line-clamp-2 font-heading text-2xl font-bold tracking-tight text-balance break-words text-slate-900 sm:line-clamp-1 sm:text-[28px] sm:leading-9">{title}</h1>
            {subtitle && <p className="mt-0.5 text-sm text-slate-600 sm:truncate">{subtitle}</p>}
          </div>
        </div>
        {aside && <div className="flex shrink-0 items-center gap-1">{aside}</div>}
      </div>
    </header>
  )
}

/* ------------------------------------------------------------------ */
/* Avatar (round icon, Wise-style)                                     */
/* ------------------------------------------------------------------ */

/** folder tones deliberately avoid the status hues (green/amber/orange/red) */
export const toneTile: Record<string, string> = {
  indigo: 'bg-brand-50 text-brand-700',
  emerald: 'bg-cyan-50 text-cyan-800',
  amber: 'bg-fuchsia-50 text-fuchsia-700',
  blue: 'bg-blue-50 text-blue-700',
  sky: 'bg-sky-50 text-sky-800',
  violet: 'bg-violet-50 text-violet-700',
  slate: 'bg-slate-100 text-slate-600',
}

export function Avatar({ icon, tone = 'slate', size = 'md' }: { icon: string; tone?: string; size?: 'md' | 'lg' | 'sm' }) {
  return (
    <span
      aria-hidden
      className={clsx(
        'flex shrink-0 items-center justify-center rounded-full',
        toneTile[tone] ?? toneTile.slate,
        size === 'lg' ? 'size-12' : size === 'sm' ? 'size-9' : 'size-11',
      )}
    >
      <Icon name={icon} size={size === 'lg' ? 24 : size === 'sm' ? 18 : 22} />
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Status tag + budget line                                            */
/* ------------------------------------------------------------------ */

const statusCls: Record<string, string> = {
  ok: 'bg-emerald-50 text-emerald-800',
  caution: 'bg-amber-50 text-amber-800',
  warn: 'bg-orange-50 text-orange-800',
  over: 'bg-rose-50 text-rose-800',
  none: 'bg-slate-100 text-slate-700',
}
export const statusText: Record<string, string> = {
  ok: 'text-emerald-800',
  caution: 'text-amber-800',
  warn: 'text-orange-800',
  over: 'text-rose-700',
  none: 'text-slate-600',
}
const statusIcon: Record<string, string> = {
  ok: 'check_circle',
  caution: 'error',
  warn: 'warning',
  over: 'report',
  none: 'remove_circle_outline',
}

export function StatusTag({ tone, word }: { tone: string; word: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full py-0.5 pr-2.5 pl-1.5 text-[13px] font-semibold whitespace-nowrap', statusCls[tone] ?? statusCls.none)}>
      <Icon name={statusIcon[tone] ?? 'info'} size={16} fill />
      {word}
    </span>
  )
}

/** spoken summary of a budget, used inside row link names */
export function budgetPhrase(total: number, cap: number) {
  if (!total) return 'not priced yet'
  if (!cap) return 'no cap set'
  const st = budgetStatus(total, cap)
  return `${st.word.toLowerCase()}, ${Math.round(st.pct)}% of cap`
}

/** row right-column budget line: "Near cap · 82% of 2.500.000 €" — status in words, no chip */
export function BudgetMini({ total, cap, label }: { total: number; cap: number; label: string }) {
  const st = budgetStatus(total, cap)
  if (!total) return <span className="text-sm text-slate-600">Not priced yet</span>
  if (!cap) return <span className="text-sm text-slate-600">No cap set</span>
  return (
    <span className="flex items-center gap-2 text-sm whitespace-nowrap text-slate-600 sm:justify-end">
      {st.tone !== 'ok' && <span className={clsx('font-semibold', statusText[st.tone])}>{st.word} ·</span>}
      <span className="num">{Math.round(st.pct)}% of {moneyWhole(cap)}</span>
      <Meter value={st.pct} tone={st.tone} className="hidden w-14 flex-none sm:block" label={label} />
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Summary — the one hero number per screen                            */
/* ------------------------------------------------------------------ */

export function Summary({
  label, amount, total, cap, actions, meta, capLabel = 'cap', compact, statusWord, bar, extra,
}: {
  /** list page: actions sit to the right of the number so the table starts higher */
  compact?: boolean
  /** override the status word, e.g. "On track overall" when a child is near its cap */
  statusWord?: string
  label: string
  amount: string
  total: number
  cap: number
  /** replaces the plain meter, e.g. a bar split by pricing section */
  bar?: ReactNode
  /** rendered under the meta line, e.g. an expandable breakdown */
  extra?: ReactNode
  actions?: ReactNode
  meta?: ReactNode
  capLabel?: string
}) {
  const st = budgetStatus(total, cap)
  const left = cap - total
  return (
    <section aria-label={label} className={clsx(compact ? 'mb-6 sm:flex sm:items-end sm:justify-between sm:gap-8' : 'mb-10')}>
      <div className="min-w-0 sm:flex-1">
      <div className="text-sm font-medium text-slate-600">{label}</div>
      <div className={clsx('num mt-1 leading-tight font-semibold tracking-tight text-slate-900', compact ? 'text-[30px] sm:text-[38px]' : 'text-[34px] sm:text-[44px]')}>{amount}</div>
      <div className="mt-3 max-w-xl">
        {cap ? (
          <>
            {bar ?? <Meter value={st.pct} tone={st.tone} height="h-2" className="max-w-md" label={`${label}: share of ${capLabel} used`} />}
            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-slate-700">
              <StatusTag tone={st.tone} word={statusWord ?? st.word} />
              <span className="num">
                <strong className="font-semibold text-slate-900">{Math.round(st.pct)}%</strong> of{' '}
                {moneyWhole(cap)} {capLabel}
              </span>
              <span className="num text-slate-600">{left >= 0 ? `${moneyWhole(left)} left` : `${moneyWhole(-left)} over`}</span>
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
            <StatusTag tone="none" word="No cap set" />
          </div>
        )}
      </div>
      {meta && <div className="mt-2 text-sm text-slate-600">{meta}</div>}
      {extra}
      </div>
      {actions && <div className={clsx('flex flex-wrap items-center gap-2', compact ? 'mt-5 sm:mt-0 sm:shrink-0' : 'mt-6')}>{actions}</div>}
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Sections + rows                                                     */
/* ------------------------------------------------------------------ */

export function Section({ title, count, tools, children, className, id }: { title: string; count?: number; tools?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  const hid = id ?? `sec-${title.toLowerCase().replace(/\W+/g, '-')}`
  return (
    <section aria-labelledby={hid} className={clsx('mb-8', className)}>
      <div className="mb-2 flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-2 px-1">
        <h2 id={hid} className="font-heading text-base font-bold text-slate-900">
          {title}
          {count !== undefined && <span className="num ml-2 font-sans text-sm font-medium text-slate-600">{count}</span>}
        </h2>
        {tools && <div className="flex items-center gap-2">{tools}</div>}
      </div>
      {children}
    </section>
  )
}

export function RowMenu({ items, label }: { items: (MenuItem | 'sep')[]; label: string }) {
  return (
    <Menu
      label={label}
      items={items}
      trigger={(p) => (
        <button
          {...p}
          type="button"
          aria-label={label}
          title="More options"
          className="relative z-10 flex size-10 shrink-0 items-center justify-center rounded-full text-slate-600 transition-colors hover:bg-slate-200/70 hover:text-slate-900"
        >
          <Icon name="more_horiz" size={20} />
        </button>
      )}
    />
  )
}

/**
 * Wise-style list row: round icon · title / subtitle · amount / meta · menu.
 * The whole row is one link (stretched); the menu sits above it.
 * Phones stack it: title (two lines max), then subtitle, then amount + meta on one line.
 */
export function Row({
  to, onOpen, label, icon, tone, title, subtitle, amount, meta, menu, selectMode, selected, onToggle, dataRow,
}: {
  to?: string
  onOpen?: () => void
  label: string
  icon: string
  tone?: string
  title: ReactNode
  subtitle?: ReactNode
  amount?: ReactNode
  meta?: ReactNode
  menu?: ReactNode
  selectMode?: boolean
  selected?: boolean
  onToggle?: () => void
  dataRow?: string
}) {
  const hit = 'absolute inset-0 z-0 rounded-2xl'
  return (
    <div
      data-row={dataRow}
      className={clsx(
        'group relative flex items-start gap-3.5 rounded-2xl px-3 py-3 transition-colors sm:items-center sm:gap-4 sm:px-4',
        selected ? 'bg-brand-50' : 'hover:bg-slate-50',
      )}
    >
      {selectMode ? (
        <button type="button" role="checkbox" aria-checked={!!selected} aria-label={`Select ${label}`} onClick={onToggle} className={hit} />
      ) : to ? (
        <Link to={to} aria-label={label} className={hit} />
      ) : (
        <button type="button" aria-label={label} onClick={onOpen} className={hit} />
      )}
      {selectMode ? (
        <span aria-hidden className={clsx('flex size-11 shrink-0 items-center justify-center rounded-full border-2', selected ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-400 bg-white')}>
          {selected && <Icon name="check" size={22} />}
        </span>
      ) : (
        <Avatar icon={icon} tone={tone} />
      )}
      <div className="pointer-events-none relative flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[15px] leading-snug font-semibold break-words text-slate-900 sm:line-clamp-1">{title}</div>
          {subtitle && <div className="mt-0.5 truncate text-sm text-slate-600">{subtitle}</div>}
        </div>
        {(amount || meta) && (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 sm:block sm:shrink-0 sm:text-right">
            {amount && <div className="num text-[15px] font-semibold text-slate-900">{amount}</div>}
            {meta && <div className="sm:mt-0.5">{meta}</div>}
          </div>
        )}
      </div>
      {menu && !selectMode && <div className="relative z-10 -my-1 -mr-1 sm:my-0">{menu}</div>}
    </div>
  )
}

export function RowList({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('-mx-1 flex flex-col', className)}>{children}</div>
}

/** soft filled pill used in section toolbars (sort, select, filter) */
export function ToolButton({ icon, children, className, active, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: string; active?: boolean; ref?: React.Ref<HTMLButtonElement> }) {
  return (
    <button
      type="button"
      className={clsx(
        'inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-colors',
        active ? 'bg-brand-50 text-brand-700 ring-1 ring-brand-200' : 'bg-slate-100 text-slate-800 hover:bg-slate-200',
        className,
      )}
      {...rest}
    >
      {icon && <Icon name={icon} size={18} className={active ? 'text-brand-700' : 'text-slate-600'} />}
      {children}
    </button>
  )
}

/** the one sort control: "Sort: Highest amount" with the same labels on every screen */
export function SortMenu<K extends string>({ value, options, onChange, noun }: { value: K; options: Record<K, string>; onChange: (k: K) => void; noun: string }) {
  return (
    <Menu
      label={`Sort ${noun}`}
      width="w-56"
      items={(Object.keys(options) as K[]).map((k) => ({ label: options[k], checked: value === k, onSelect: () => onChange(k) }))}
      trigger={(p) => (
        <ToolButton {...p} icon="swap_vert">
          <span>Sort<span className="max-sm:sr-only">: {options[value]}</span></span>
        </ToolButton>
      )}
    />
  )
}

/** segmented filter chips ("All", "Needs attention 2") with a shared selected style */
export function Chips<K extends string>({ value, options, onChange, label }: { value: K; options: { key: K; label: string; count?: number }[]; onChange: (k: K) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = o.key === value
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.key)}
            className={clsx(
              'inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors',
              on ? 'bg-brand-50 font-semibold text-brand-700 ring-1 ring-brand-200' : 'bg-slate-100 text-slate-800 hover:bg-slate-200',
            )}
          >
            {o.label}
            {o.count !== undefined && <span className={clsx('num', on ? 'text-brand-700' : 'text-slate-600')}>{o.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** calm, unboxed empty state — one sentence and at most one way forward */
export function EmptyState({ icon, title, text, children }: { icon?: string; title: string; text?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center sm:py-20">
      {icon && (
        <span className="mb-4 flex size-14 items-center justify-center rounded-full bg-slate-100 text-slate-600">
          <Icon name={icon} size={28} />
        </span>
      )}
      <h2 className="font-heading text-lg font-bold text-balance text-slate-900">{title}</h2>
      {text && <p className="mt-1.5 max-w-sm text-sm text-balance text-slate-600">{text}</p>}
      {children && <div className="mt-6 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  )
}
