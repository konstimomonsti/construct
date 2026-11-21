import { clsx } from 'clsx'
import { Fragment, useId, type ReactNode } from 'react'
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
          <Link to={c.to} className="truncate rounded transition-colors hover:text-slate-900 hover:underline">{c.label}</Link>
          <Icon name="chevron_right" size={16} className="shrink-0 text-slate-400" />
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
            <h1 className="line-clamp-2 font-heading text-2xl font-extrabold tracking-tight text-balance break-words text-slate-900 sm:line-clamp-1 sm:text-[28px] sm:leading-9">{title}</h1>
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

/** every project and list gets the same tile: colour is kept for budget status, so tiles carry no hue of their own */
export const toneTile: Record<string, string> = {
  indigo: 'bg-brand-50 text-brand-700',
  emerald: 'bg-brand-50 text-brand-700',
  amber: 'bg-brand-50 text-brand-700',
  blue: 'bg-brand-50 text-brand-700',
  sky: 'bg-brand-50 text-brand-700',
  violet: 'bg-brand-50 text-brand-700',
  slate: 'bg-brand-50 text-brand-700',
}

export function Avatar({ icon, tone = 'slate', size = 'md' }: { icon: string; tone?: string; size?: 'md' | 'lg' | 'sm' }) {
  return (
    <span
      aria-hidden
      className={clsx(
        'flex shrink-0 items-center justify-center rounded-lg',
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

/** one threshold per status word; spoken after the word, never a mouse-only tooltip */
export const STATUS_HINT: Record<string, string> = {
  ok: 'below 75% of the cap used',
  caution: '75 to 89% of the cap used',
  warn: '90 to 100% of the cap used',
  over: 'more than the cap used',
  none: '',
}

export function StatusTag({ tone, word, small, hint }: { tone: string; word: string; small?: boolean; hint?: boolean }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-md font-semibold whitespace-nowrap',
        small ? 'py-px pr-2 pl-1 text-xs' : 'py-0.5 pr-2.5 pl-1.5 text-[13px]',
        statusCls[tone] ?? statusCls.none,
      )}
    >
      <Icon name={statusIcon[tone] ?? 'info'} size={small ? 14 : 16} fill />
      {word}
      {hint && STATUS_HINT[tone] && <span className="sr-only">, {STATUS_HINT[tone]}</span>}
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
      <span className="num">{Math.round(st.pct)}%<span className="max-sm:sr-only"> of {moneyWhole(cap)}</span></span>
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
}

/** the cap figure with a visible pencil: the cap is a setting, so it reads as one */
function CapButton({ cap, capLabel, onClick }: { cap: number; capLabel: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${capLabel === 'cap' ? 'Cap' : capLabel}: ${moneyWhole(cap)}. Edit budget cap`}
      className="group/cap relative inline-flex items-center gap-1 rounded text-slate-700 hover:text-slate-900 after:absolute after:-inset-x-1 after:-inset-y-3 after:content-['']"
    >
      <span className="underline decoration-slate-400 decoration-dotted underline-offset-4 group-hover/cap:decoration-slate-900">{moneyWhole(cap)}</span>
      <Icon name="edit" size={14} className="text-slate-500 group-hover/cap:text-slate-900" />
    </button>
  )
}

/**
 * One hero per screen: label, number, bar, ONE status line, at most one muted line, actions.
 * The pill always shows the worst state (a project near its cap makes the whole page "1 near cap").
 */
export function Summary({
  label, amount, total, cap, actions, meta, capLabel = 'cap', compact, status, bar, extra, hideLeft, note, onEditCap,
}: {
  /** one muted line under the status line, e.g. which caps the figure is measured against */
  note?: ReactNode
  /** makes "x% of cap" a button that opens the cap editor */
  onEditCap?: () => void
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
    <section aria-label={label} className={compact ? 'mb-6' : actions ? 'mb-10' : 'mb-8'}>
      {/* the figure on the left, the two numbers it is judged by on the right, the jib across the full width */}
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-600">{label}</div>
          <BigMoney value={amount} className={clsx('num display mt-1 block leading-[1.05] text-slate-900', compact ? 'text-[30px] sm:text-[44px]' : 'text-[34px] sm:text-[54px]')} />
          {/* on phones the hero states the two judging numbers in one line, so the work starts sooner */}
          {cap > 0 && (
            <p className="num mt-1 text-sm text-slate-600 sm:hidden">
              {Math.round(st.pct)}% of {onEditCap ? <CapButton cap={cap} capLabel={capLabel} onClick={onEditCap} /> : moneyWhole(cap)} · <span className={left < 0 ? 'font-semibold text-rose-700' : undefined}>{money(Math.abs(left))} {left >= 0 ? 'left' : 'over'}</span>
            </p>
          )}
        </div>
        {cap > 0 && (
          <dl className="flex gap-x-10 gap-y-2 pb-1 max-sm:hidden sm:text-right">
            <div>
              <dt className="text-sm text-slate-600">Used</dt>
              <dd className="num mt-0.5 text-xl font-semibold text-slate-900 sm:text-2xl">{Math.round(st.pct)}%</dd>
              <dd className="num text-sm text-slate-600">
                of{' '}
                {onEditCap ? <CapButton cap={cap} capLabel={capLabel} onClick={onEditCap} /> : moneyWhole(cap)}
              </dd>
            </div>
            {!hideLeft && (
              <div>
                <dt className="text-sm text-slate-600">{left >= 0 ? 'Left' : 'Over'}</dt>
                <dd className={clsx('num mt-0.5 text-xl font-semibold sm:text-2xl', left >= 0 ? 'text-slate-900' : 'text-rose-700')}>{money(Math.abs(left))}</dd>
                <dd className="text-sm text-slate-600">{left >= 0 ? 'before the cap' : 'past the cap'}</dd>
              </div>
            )}
          </dl>
        )}
      </div>
      {cap ? (
        <>
          <div className={compact ? 'mt-3 sm:mt-4' : 'mt-5'}>{bar ?? <TrussMeter total={total} cap={cap} tone={st.tone} label={`${label}: share of ${capLabel} used`} />}</div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-sm text-slate-600">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <StatusTag tone={pill.tone} word={pill.word} hint />
              {note && <span className="max-sm:hidden">{note}</span>}
            </div>
            {meta && <div>{meta}</div>}
          </div>
        </>
      ) : (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-sm text-slate-600">
          <div className="flex flex-wrap items-center gap-3">
            <StatusTag tone="none" word="No cap set" />
            {onEditCap && (
              <button type="button" onClick={onEditCap} className="h-9 rounded-md bg-slate-100 px-3 font-medium text-slate-900 hover:bg-slate-200">Set a cap</button>
            )}
          </div>
          {meta && <div>{meta}</div>}
        </div>
      )}
      {extra}
      {actions && <div className={clsx('flex flex-wrap items-center gap-2', compact ? 'mt-4' : 'mt-6')}>{actions}</div>}
    </section>
  )
}

const trussInk: Record<string, string> = {
  ok: 'text-emerald-600',
  caution: 'text-amber-500',
  warn: 'text-orange-500',
  over: 'text-rose-600',
  none: 'text-slate-400',
}

/**
 * The hero meter, drawn as a crane jib: two chords and a zigzag web. The jib is the cap; the
 * lit part is what is spent; a hook hangs where spending stands. Past the cap the jib extends and
 * a mast marks where the cap was.
 */
export function TrussMeter({ total, cap, tone, label }: { total: number; cap: number; tone: string; label: string }) {
  const id = useId().replace(/:/g, '')
  const pct = cap > 0 ? (total / cap) * 100 : 0
  const scale = Math.max(total, cap) || 1
  const fill = Math.max(0, Math.min(100, (total / scale) * 100))
  const capAt = (cap / scale) * 100
  const hookAt = Math.max(1.5, Math.min(98.5, fill))
  /* a pattern takes its colour from where it is defined, so each jib carries its own web */
  const jib = (key: string) => (
    <>
      <pattern id={`${id}-${key}`} width="16" height="18" patternUnits="userSpaceOnUse">
        <path d="M0 17 L8 1 L16 17" fill="none" stroke="currentColor" strokeWidth="1.25" />
      </pattern>
      <line x1="0" y1="1" x2="100%" y2="1" strokeWidth="2" />
      <line x1="0" y1="17" x2="100%" y2="17" strokeWidth="2" />
      <rect x="0" y="0" width="100%" height="18" fill={`url(#${id}-${key})`} stroke="none" />
    </>
  )
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.min(pct, 100))}
      aria-valuetext={`${Math.round(pct)}%`}
      aria-label={label}
      className="relative pb-4"
    >
      <svg width="100%" height="18" className="block overflow-visible" aria-hidden>
        <defs>
          <clipPath id={`${id}-clip`}>
            <rect x="0" y="-2" height="22" className="transition-[width] duration-700 ease-out-expo motion-reduce:transition-none" style={{ width: `${fill}%` }} />
          </clipPath>
        </defs>
        <g className="text-slate-400" stroke="currentColor" strokeDasharray="4 3">{jib('rest')}</g>
        <g className={trussInk[tone] ?? trussInk.none} stroke="currentColor" clipPath={`url(#${id}-clip)`}>{jib('lit')}</g>
        <rect x={`${capAt}%`} y="-5" width="3" height="28" className="fill-slate-700" transform="translate(-1.5 0)" />
      </svg>
      <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden className={clsx('absolute top-[17px] -translate-x-1/2 transition-[left] duration-700 ease-out-expo motion-reduce:transition-none', trussInk[tone] ?? trussInk.none)} style={{ left: `${hookAt}%` }}>
        <path d="M6 0 V8 M6 8 C6 8 2.5 8 2.5 11.5 C2.5 15 9.5 15 9.5 11.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      </svg>
    </div>
  )
}

const RANK: Record<string, number> = { none: 0, ok: 0, caution: 1, warn: 2, over: 3 }

const PHRASE: Record<string, string> = { over: 'over cap', warn: 'almost at cap', caution: 'near cap' }

/**
 * Aggregate pill: the worst state wins. When the total itself is fine but children are flagged,
 * the pill counts them per level, worst first ("1 list almost at cap · 1 near cap").
 */
export function heroStatus(own: { total: number; cap: number }, children: { tone: string }[], noun: [string, string]): HeroStatus | undefined {
  const mine = budgetStatus(own.total, own.cap)
  const flagged = children.filter((c) => RANK[c.tone] > 0)
  if (!flagged.length) return undefined
  const worst = flagged.reduce((w, c) => (RANK[c.tone] > RANK[w] ? c.tone : w), 'caution')
  if (RANK[mine.tone] >= RANK[worst]) return undefined
  const parts = (['over', 'warn', 'caution'] as const)
    .map((t) => [t, flagged.filter((c) => c.tone === t).length] as const)
    .filter(([, n]) => n > 0)
    .map(([t, n], i) => (i === 0 ? `${n} ${n === 1 ? noun[0] : noun[1]} ${PHRASE[t]}` : `${n} ${PHRASE[t]}`))
  return { tone: worst, word: parts.join(' · ') }
}

/** worst status of an object's own cap and its children's caps (a project is as bad as its worst list) */
export function worstTone(own: { total: number; cap: number }, children: { total: number; cap: number }[] = []) {
  return [own, ...children]
    .filter((x) => x.total > 0 && x.cap > 0)
    .map((x) => budgetStatus(x.total, x.cap).tone as string)
    .reduce((w, t) => (RANK[t] > RANK[w] ? t : w), 'ok')
}

/** a filter link inside hero meta: only the action words are underlined */
export function MetaLink({ children, onClick, pressed }: { children: ReactNode; onClick: () => void; pressed?: boolean }) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick} className="relative inline-flex h-7 items-center gap-1 rounded-md bg-slate-100 px-2 font-medium text-slate-900 after:absolute after:inset-x-0 after:-inset-y-2 after:content-[''] hover:bg-slate-200 aria-pressed:bg-slate-900 aria-pressed:text-white">
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
          className="relative z-10 flex size-10 shrink-0 items-center justify-center rounded-md text-slate-600 transition-colors hover:bg-slate-200/70 hover:text-slate-900"
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
  const hit = 'absolute inset-0 z-0 rounded-lg'
  return (
    <div
      data-row={dataRow}
      className={clsx(
        'group relative flex items-start gap-3 rounded-lg px-2 py-3 transition-colors sm:items-center sm:gap-4 sm:px-3',
        selected ? 'bg-brand-50' : 'hover:bg-slate-100',
      )}
    >
      {selectMode ? (
        <button type="button" data-nav role="checkbox" aria-checked={!!selected} aria-label={`Select ${label}`} onClick={onToggle} className={hit} />
      ) : to ? (
        <Link to={to} data-nav aria-label={label} className={hit} />
      ) : (
        <button type="button" data-nav aria-label={label} onClick={onOpen} className={hit} />
      )}
      {selectMode ? (
        <span aria-hidden className={clsx('flex size-11 shrink-0 items-center justify-center rounded-full border-2', selected ? 'border-brand-600 bg-brand-600 text-ink' : 'border-slate-400 bg-white')}>
          {selected && <Icon name="check" size={22} />}
        </span>
      ) : (
        <Avatar icon={icon} tone={tone} />
      )}
      <div className="pointer-events-none relative grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-baseline sm:grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 sm:gap-x-6">
        <div className="col-span-2 row-start-1 flex min-w-0 items-center gap-2 sm:col-span-1">
          <span lang="de" className="line-clamp-2 text-[15px] leading-snug font-semibold break-normal hyphens-auto text-slate-900 sm:line-clamp-1">{title}</span>
          {badge && <span className="shrink-0 empty:hidden max-sm:hidden">{badge}</span>}
        </div>
        {(subtitle || badge) && (
          <div className="col-span-2 row-start-2 flex min-w-0 items-center gap-2 text-sm text-slate-600 sm:col-span-1 sm:col-start-1">
            {badge && <span className="shrink-0 empty:hidden sm:hidden">{badge}</span>}
            {subtitle && <span className="truncate">{subtitle}</span>}
          </div>
        )}
        {amount && <div className="num col-start-1 row-start-3 text-[15px] font-semibold whitespace-nowrap text-slate-900 sm:col-start-2 sm:row-start-1 sm:text-right">{amount}</div>}
        {meta && <div className="col-start-2 row-start-3 flex min-w-0 justify-end sm:row-start-2">{meta}</div>}
      </div>
      {menu && !selectMode && (
        <div className="relative z-10 -my-1.5 -mr-1 transition-opacity sm:my-0 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:has-[[aria-expanded=true]]:opacity-100">{menu}</div>
      )}
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
        'inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md px-3.5 text-sm font-medium whitespace-nowrap transition-colors',
        active ? 'bg-slate-900 text-white hover:bg-slate-800' : 'bg-slate-100 text-slate-800 hover:bg-slate-200',
        className,
      )}
      {...rest}
    >
      {icon && <Icon name={icon} size={18} className={active ? 'text-white' : 'text-slate-600'} />}
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
        <ToolButton {...p} icon="swap_vert" className="max-sm:w-10 max-sm:justify-center max-sm:px-0">
          <span className="max-sm:sr-only">Sort: {options[value]}</span>
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
              'inline-flex h-10 items-center gap-2 rounded-md px-4 text-sm font-medium transition-colors',
              on ? 'bg-slate-900 font-semibold text-white' : 'bg-slate-100 text-slate-800 hover:bg-slate-200',
            )}
          >
            {o.label}
            {o.count !== undefined && <span className={clsx('num', on ? 'text-slate-200' : 'text-slate-600')}>{o.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/**
 * the empty panel: a dashed frame the width of the content, message centred inside it,
 * so an empty page still reads as a place where things will appear.
 * `active` lights the frame (files dragged over an empty project); `compact` for use inside a section.
 */
export function EmptyState({ icon, title, text, children, hint, className, active, compact }: { icon?: string; title: string; text?: ReactNode; children?: ReactNode; hint?: ReactNode; className?: string; active?: boolean; compact?: boolean }) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center rounded-lg px-5 text-center transition-colors',
        compact ? 'py-10' : 'py-12 sm:py-16',
        active === undefined ? 'border border-slate-300' : active ? 'border-2 border-dashed border-brand-600 bg-brand-50' : 'border-2 border-dashed border-slate-300',
        className,
      )}
    >
      {icon && (
        <span className={clsx('flex items-center justify-center rounded-lg bg-brand-50 text-brand-700', compact ? 'mb-3 size-12' : 'mb-5 size-16')}>
          <Icon name={icon} size={compact ? 24 : 30} />
        </span>
      )}
      <h2 className={clsx('font-heading font-bold tracking-tight text-balance text-slate-900', compact ? 'text-lg' : 'text-xl sm:text-2xl')}>{title}</h2>
      {text && <p className="mt-2 max-w-[52ch] text-[15px] leading-relaxed text-balance text-slate-600">{text}</p>}
      {children && <div className="mt-7 flex w-full flex-col items-stretch justify-center gap-2 sm:w-auto sm:flex-row sm:flex-wrap">{children}</div>}
      {hint && <p className="mt-6 max-w-md text-sm leading-relaxed text-pretty text-slate-500">{hint}</p>}
    </div>
  )
}

/** secondary pill as a link ("Go to All Projects") */
export function PillLink({ to, icon, children }: { to: string; icon?: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-slate-100 px-5 text-sm font-semibold text-slate-900 hover:bg-slate-200">
      {icon && <Icon name={icon} size={18} />}
      {children}
    </Link>
  )
}
