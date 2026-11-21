import { clsx } from 'clsx'
import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Icon, Menu, Meter, type MenuItem } from './ui'
import { Page } from './Page'
import { budgetStatus, money, moneyWhole } from '../lib/format'

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
        size === 'lg' ? 'size-10 sm:size-12' : size === 'sm' ? 'size-9' : 'size-11',
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

export const NEAR_CAP_HINT = 'Near cap: 75% or more of the cap is used'

export function StatusTag({ tone, word, small }: { tone: string; word: string; small?: boolean }) {
  return (
    <span
      title={tone === 'ok' || tone === 'none' ? undefined : NEAR_CAP_HINT}
      className={clsx(
        'inline-flex items-center gap-1 rounded-full font-semibold whitespace-nowrap',
        small ? 'py-px pr-2 pl-1 text-xs' : 'py-0.5 pr-2.5 pl-1.5 text-[13px]',
        statusCls[tone] ?? statusCls.none,
      )}
    >
      <Icon name={statusIcon[tone] ?? 'info'} size={small ? 14 : 16} fill />
      {word}
    </span>
  )
}

/** status chip for a row's title line; nothing when the budget is fine */
export function BudgetBadge({ total, cap }: { total: number; cap: number }) {
  const st = budgetStatus(total, cap)
  if (!total || !cap || st.tone === 'ok') return null
  return <StatusTag small tone={st.tone} word={st.word} />
}

/** spoken summary of a budget, used inside row link names */
export function budgetPhrase(total: number, cap: number) {
  if (!total) return 'not priced yet'
  if (!cap) return 'no cap set'
  const st = budgetStatus(total, cap)
  return `${st.word.toLowerCase()}, ${Math.round(st.pct)}% of cap`
}

/** row right-column budget line: "75% of 2.000.000 €" plus a slim meter; the status word sits on the title line (BudgetBadge) */
export function BudgetMini({ total, cap, label }: { total: number; cap: number; label: string }) {
  const st = budgetStatus(total, cap)
  if (!total) return <span className="text-sm text-slate-600">Not priced yet</span>
  if (!cap) return <span className="text-sm text-slate-600">No cap set</span>
  return (
    <span className="flex items-center justify-end gap-2 text-sm whitespace-nowrap text-slate-600">
      <span className="num">{Math.round(st.pct)}% of {moneyWhole(cap)}</span>
      <Meter value={st.pct} tone={st.tone} className="w-12 flex-none sm:w-14" label={label} />
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Summary — the one hero number per screen                            */
/* ------------------------------------------------------------------ */

/** the hero number; cents are set smaller so the euros carry the weight (Wise-style) */
export function BigMoney({ value, className }: { value: string; className?: string }) {
  const m = value.match(/^(.*?)(,\d{2})?(\u00a0€)$/)
  if (!m) return <span className={className}>{value}</span>
  return (
    <span className={className}>
      {m[1]}
      <span className="text-[0.62em] tracking-normal">{m[2] ?? ''}{m[3]}</span>
    </span>
  )
}

export interface HeroStatus {
  tone: string
  word: string
  /** turns the pill into the filter for the flagged rows below */
  onClick?: () => void
}

/**
 * One hero per screen: label, number, bar, ONE status line, at most one muted line, actions.
 * The pill always shows the worst state (a project near its cap makes the whole page "1 near cap").
 */
export function Summary({
  label, amount, total, cap, actions, meta, capLabel = 'cap', compact, status, bar, extra, hideLeft,
}: {
  compact?: boolean
  /** the hero number already is the headroom */
  hideLeft?: boolean
  status?: HeroStatus
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
  const pill = status ?? { tone: st.tone, word: st.word }
  return (
    <section aria-label={label} className={actions ? 'mb-10' : 'mb-8'}>
      <div className="text-sm font-medium text-slate-600">{label}</div>
      <BigMoney value={amount} className={clsx('num mt-1 block leading-tight font-semibold tracking-tight text-slate-900', compact ? 'text-[32px] sm:text-[40px]' : 'text-[34px] sm:text-[44px]')} />
      <div className="mt-3 max-w-xl">
        {cap ? (
          <>
            {bar ?? <Meter value={st.pct} tone={st.tone} height="h-2" className="max-w-md" label={`${label}: share of ${capLabel} used`} />}
            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-slate-700">
              {pill.onClick ? (
                <button type="button" onClick={pill.onClick} title={`${NEAR_CAP_HINT}. Show them.`} className="rounded-full transition-[filter] hover:brightness-95">
                  <span className="inline-flex items-center">
                    <StatusTag tone={pill.tone} word={pill.word} />
                  </span>
                </button>
              ) : (
                <StatusTag tone={pill.tone} word={pill.word} />
              )}
              <span className="num">
                <strong className="font-semibold text-slate-900">{Math.round(st.pct)}%</strong> of {moneyWhole(cap)}
                <span className="max-sm:hidden"> {capLabel}</span>
              </span>
              {!hideLeft && <span className="num text-slate-600">{left >= 0 ? `${money(left)} left` : `${money(-left)} over`}</span>}
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
      {actions && <div className="mt-6 flex flex-wrap items-center gap-2">{actions}</div>}
    </section>
  )
}

const RANK: Record<string, number> = { none: 0, ok: 0, caution: 1, warn: 2, over: 3 }

/**
 * Aggregate pill: the worst state wins. When the total itself is fine but children are flagged,
 * the pill names them ("1 project near cap") and becomes their filter.
 */
export function heroStatus(own: { total: number; cap: number }, children: { total: number; cap: number }[], noun: [string, string], onClick?: () => void): HeroStatus | undefined {
  const mine = budgetStatus(own.total, own.cap)
  const flagged = children.map((c) => budgetStatus(c.total, c.cap)).filter((st) => RANK[st.tone] > 0)
  if (!flagged.length) return undefined
  const worst = flagged.reduce((w, st) => (RANK[st.tone] > RANK[w] ? st.tone : w), 'caution' as string)
  if (RANK[mine.tone] >= RANK[worst]) return undefined
  const over = flagged.filter((st) => st.tone === 'over').length
  const n = over || flagged.length
  const word = `${n} ${n === 1 ? noun[0] : noun[1]} ${over ? 'over' : 'near'} cap`
  return { tone: worst, word, onClick }
}

/** a filter link inside hero meta: only the action words are underlined */
export function MetaLink({ children, onClick, pressed }: { children: ReactNode; onClick: () => void; pressed?: boolean }) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick} className="rounded font-medium text-slate-900 underline decoration-slate-400 underline-offset-4 hover:decoration-slate-900">
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Sections + rows                                                     */
/* ------------------------------------------------------------------ */

export function Section({ title, count, tools, children, className, id, focusable }: { title: string; count?: number; tools?: ReactNode; children: ReactNode; className?: string; id?: string; focusable?: boolean }) {
  const hid = id ?? `sec-${title.toLowerCase().replace(/\W+/g, '-')}`
  return (
    <section aria-labelledby={hid} className={clsx('mb-8', className)}>
      <div className="mb-2 flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id={hid} tabIndex={focusable ? -1 : undefined} className="rounded font-heading text-base font-bold text-slate-900">
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
 * Wise-style list row: round icon · title (+ status chip) / subtitle · amount / meta · menu.
 * The whole row is one link (stretched); the menu sits above it. The row's content lines up with
 * the page column and its hover fill bleeds 12px outside it, so every trailing control shares one edge.
 * Phones keep the same anatomy: amount right on the title line, the budget line under the subtitle.
 */
export function Row({
  to, onOpen, label, icon, tone, title, badge, subtitle, amount, meta, menu, selectMode, selected, onToggle, dataRow,
}: {
  to?: string
  onOpen?: () => void
  label: string
  icon: string
  tone?: string
  title: ReactNode
  badge?: ReactNode
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
        'group relative flex items-start gap-3 rounded-2xl px-2 py-3 transition-colors sm:items-center sm:gap-4 sm:px-3',
        selected ? 'bg-brand-50' : 'hover:bg-slate-100',
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
      <div className="pointer-events-none relative grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 sm:gap-x-6">
        <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-2">
          <span className="line-clamp-2 text-[15px] leading-snug font-semibold break-words text-slate-900 sm:line-clamp-1">{title}</span>
          {badge && <span className="pointer-events-auto shrink-0">{badge}</span>}
        </div>
        {amount && <div className="num col-start-2 row-start-1 text-right text-[15px] font-semibold whitespace-nowrap text-slate-900">{amount}</div>}
        {subtitle && <div className="col-span-2 row-start-2 truncate text-sm text-slate-600 sm:col-span-1 sm:col-start-1">{subtitle}</div>}
        {meta && <div className="col-span-2 row-start-3 flex justify-end sm:col-span-1 sm:col-start-2 sm:row-start-2">{meta}</div>}
      </div>
      {menu && !selectMode && <div className="relative z-10 -my-1.5 -mr-1 sm:my-0">{menu}</div>}
    </div>
  )
}

export function RowList({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('-mx-2 flex flex-col sm:-mx-3', className)}>{children}</div>
}

/** soft filled pill used in section toolbars (sort, select, filter) */
export function ToolButton({ icon, children, className, active, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: string; active?: boolean; ref?: React.Ref<HTMLButtonElement> }) {
  return (
    <button
      type="button"
      className={clsx(
        'inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-colors',
        active ? 'bg-brand-50 text-brand-700 ring-1 ring-brand-300 ring-inset' : 'bg-slate-100 text-slate-800 ring-1 ring-slate-300 ring-inset hover:bg-slate-200',
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
              on ? 'bg-brand-50 font-semibold text-brand-700 ring-1 ring-brand-300 ring-inset' : 'bg-slate-100 text-slate-800 ring-1 ring-slate-300 ring-inset hover:bg-slate-200',
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

/** calm empty state, left-aligned with the page title so every page has one axis */
export function EmptyState({ icon, title, text, children, hint, className }: { icon?: string; title: string; text?: ReactNode; children?: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={clsx('max-w-xl py-10 sm:py-14', className)}>
      {icon && (
        <span className="mb-5 flex size-16 items-center justify-center rounded-full bg-slate-100 text-slate-600">
          <Icon name={icon} size={32} />
        </span>
      )}
      <h2 className="font-heading text-xl font-bold tracking-tight text-balance text-slate-900">{title}</h2>
      {text && <p className="mt-2 text-[15px] leading-relaxed text-pretty text-slate-600">{text}</p>}
      {children && <div className="mt-7 flex flex-col gap-2 min-[400px]:flex-row min-[400px]:flex-wrap">{children}</div>}
      {hint && <p className="mt-5 text-[13px] leading-relaxed text-slate-500">{hint}</p>}
    </div>
  )
}

/** secondary pill as a link ("Go to All Projects") */
export function PillLink({ to, icon, children }: { to: string; icon?: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-slate-100 px-5 text-sm font-semibold text-slate-900 ring-1 ring-slate-300 ring-inset hover:bg-slate-200">
      {icon && <Icon name={icon} size={18} />}
      {children}
    </Link>
  )
}
