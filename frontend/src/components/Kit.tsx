import { clsx } from 'clsx'
import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Icon, kbdCls, Menu, type MenuItem } from './ui'
import { raisedCls } from '../lib/cls'
import { Page } from './Page'
import { int } from '../lib/format'
import { MOD_KEY } from '../lib/keys'

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
  crumbs = [], title, subtitle, icon, tone, aside, wrap,
}: {
  crumbs?: Crumb[]
  title: ReactNode
  subtitle?: ReactNode
  icon?: string
  tone?: string
  aside?: ReactNode
  /** let a long title and subtitle take a second line instead of truncating (tender names and references) */
  wrap?: boolean
}) {
  return (
    <header className="mb-6">
      <Crumbs items={crumbs} />
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          {icon && <Avatar icon={icon} tone={tone} size="lg" />}
          <div className="min-w-0">
            <h1 className={clsx('line-clamp-2 font-heading text-2xl font-extrabold tracking-tight text-balance break-words text-slate-900 sm:text-[28px] sm:leading-9', !wrap && 'sm:line-clamp-1')}>{title}</h1>
            {subtitle && <p className={clsx('mt-0.5 text-sm text-slate-600', wrap ? 'line-clamp-2 text-pretty' : 'sm:truncate')}>{subtitle}</p>}
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

/** every project and list gets the same tile: tiles carry no hue of their own */
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
/* Summary                                            */
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

export function Summary({ label, amount, sub }: { label: string; amount: string; sub?: ReactNode }) {
  return (
    <section aria-label={label} className="mb-8">
      <div className="text-sm font-semibold text-slate-800">{label}</div>
      <BigMoney value={amount} className="num display mt-1 block text-[34px] leading-[1.05] text-slate-900 sm:text-[54px]" />
      {sub && <div className="mt-1.5 text-sm text-slate-600">{sub}</div>}
    </section>
  )
}

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

/**
 * a titled block of rows. `filters` (Chips) share the heading row with the tools on wide screens, so the first row
 * starts sooner; on phones they take their own line under the heading.
 */
export function Section({ title, count, tools, filters, children, className, id, focusable }: { title: string; count?: number; tools?: ReactNode; filters?: ReactNode; children: ReactNode; className?: string; id?: string; focusable?: boolean }) {
  const hid = id ?? `sec-${title.toLowerCase().replace(/\W+/g, '-')}`
  return (
    <section aria-labelledby={hid} className={clsx('mb-8', className)}>
      <div className={clsx('flex min-h-10 flex-wrap items-center gap-x-2 gap-y-3', filters ? 'mb-3' : 'mb-2')}>
        <h2 id={hid} tabIndex={focusable ? -1 : undefined} className="mr-auto rounded pr-1 font-heading text-base font-bold text-slate-900">
          {title}
          {count !== undefined && <span className="num ml-2 font-sans text-sm font-medium text-slate-600">{count}</span>}
        </h2>
        {filters && <div className="max-md:order-last max-md:w-full md:mr-4">{filters}</div>}
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
 * Phones keep the same anatomy: amount right on the title line, the metadata under the subtitle.
 *
 * Mouse devices keep a fixed action gutter, so figures never move when the ⋯ appears on hover or focus: where the
 * page has a wide enough margin (≥1400px) the gutter sits outside the content edge and the figures end on that edge,
 * like the hero and the toolbars; on narrower windows the gutter is reserved inside the row.
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
        menu && !selectMode && 'sm:max-[1399px]:[@media(hover:hover)]:pr-[60px] min-[1400px]:[@media(hover:hover)]:-mr-10 min-[1400px]:[@media(hover:hover)]:pr-[52px]',
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
      <div className="pointer-events-none relative grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-6">
        {/* a long name takes two lines; when the status chip no longer fits beside it, the chip wraps under the name */}
        <div className="col-span-2 row-start-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:col-span-1">
          <span lang="de" className="line-clamp-2 min-w-0 text-[15px] leading-snug font-semibold break-normal hyphens-auto text-slate-900">{title}</span>
          {badge && <span className="shrink-0 empty:hidden max-sm:hidden">{badge}</span>}
        </div>
        {(subtitle || badge) && (
          <div className="col-span-2 row-start-2 flex min-w-0 items-center gap-2 text-sm text-slate-600 sm:col-span-1 sm:col-start-1">
            {badge && <span className="shrink-0 empty:hidden sm:hidden">{badge}</span>}
            {subtitle && <span className="truncate">{subtitle}</span>}
          </div>
        )}
        {amount && <div className="num col-start-1 row-start-3 text-base font-bold whitespace-nowrap text-slate-900 sm:col-start-2 sm:row-start-1 sm:text-right">{amount}</div>}
        {meta && <div className="col-start-2 row-start-3 flex min-w-0 justify-end sm:row-start-2">{meta}</div>}
      </div>
      {menu && !selectMode && (
        <div className="relative z-10 -my-1.5 -mr-1 transition-opacity sm:my-0 [@media(hover:hover)]:absolute [@media(hover:hover)]:top-1/2 [@media(hover:hover)]:right-1 [@media(hover:hover)]:my-0 [@media(hover:hover)]:mr-0 [@media(hover:hover)]:-translate-y-1/2 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:has-[[aria-expanded=true]]:opacity-100 sm:[@media(hover:hover)]:right-2 min-[1400px]:[@media(hover:hover)]:right-1.5">{menu}</div>
      )}
    </div>
  )
}

export function RowList({ children, className }: { children: ReactNode; className?: string }) {
  // hairlines between rows give the list a structure to scan down; the hover fill still bleeds past them
  return <div className={clsx('-mx-2 flex flex-col divide-y divide-slate-200 sm:-mx-3', className)}>{children}</div>
}

/** soft filled pill used in section toolbars (sort, select, filter) */
export function ToolButton({ icon, children, className, active, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: string; active?: boolean; ref?: React.Ref<HTMLButtonElement> }) {
  return (
    <button
      type="button"
      className={clsx(
        'inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md px-3.5 text-sm font-medium whitespace-nowrap transition-colors',
        active ? 'bg-slate-900 text-white hover:bg-slate-800' : raisedCls,
        className,
      )}
      {...rest}
    >
      {icon && <Icon name={icon} size={18} className={active ? 'text-white' : 'text-slate-700'} />}
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
              on ? 'bg-slate-900 font-semibold text-white' : raisedCls,
            )}
          >
            {o.label}
            {o.count !== undefined && <span className={clsx('num', on ? 'text-slate-200' : 'text-slate-600')}>{int(o.count)}</span>}
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
        compact ? 'py-8' : 'py-10 sm:py-12',
        active === undefined ? 'border border-slate-300' : active ? 'border-2 border-dashed border-brand-600 bg-brand-50' : 'border-2 border-dashed border-slate-300',
        className,
      )}
    >
      {icon && (
        <span className={clsx('flex items-center justify-center rounded-lg bg-brand-50 text-brand-700', compact ? 'mb-3 size-12' : 'mb-4 size-14')}>
          <Icon name={icon} size={compact ? 24 : 28} />
        </span>
      )}
      <h2 className={clsx('font-heading font-bold tracking-tight text-balance text-slate-900', compact ? 'text-lg' : 'text-xl sm:text-2xl')}>{title}</h2>
      {text && <p className="mt-2 max-w-[52ch] text-[15px] leading-relaxed text-balance text-slate-600">{text}</p>}
      {children && <div className="mt-5 flex w-full flex-col items-stretch justify-center gap-2 sm:w-auto sm:flex-row sm:flex-wrap">{children}</div>}
      {hint && <p className="mt-3 max-w-md text-sm leading-relaxed text-pretty text-slate-600">{hint}</p>}
    </div>
  )
}

/** secondary pill as a link ("Go to All Projects") */
export function PillLink({ to, icon, children }: { to: string; icon?: string; children: ReactNode }) {
  return (
    <Link to={to} className={clsx('inline-flex h-10 items-center justify-center gap-2 rounded-md px-5 text-sm font-semibold', raisedCls)}>
      {icon && <Icon name={icon} size={18} />}
      {children}
    </Link>
  )
}

/** a key chip, the same one the header search shows ("⌘K") */
export function Kbd({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  return <kbd aria-label={label} className={clsx(kbdCls, className)}>{children}</kbd>
}

/** the search shortcut in this platform's words: ⌘K on a Mac, Ctrl K elsewhere */
export function PaletteKey({ className }: { className?: string }) {
  return <Kbd className={className}>{MOD_KEY === '⌘' ? '⌘K' : 'Ctrl K'}</Kbd>
}
