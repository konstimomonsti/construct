import { clsx } from 'clsx'
import { useMemo, type ReactNode } from 'react'
import { Button, Icon, toast } from '../ui'
import { useSubNames, type SubName } from './names'
import { int, money, plural } from '../../lib/format'
import type { PriceSuggestion } from '../../lib/price-suggestions'
import { useStore } from '../../lib/store'
import { offerOf, type SubcontractPackage } from '../../lib/subcontract'
import type { Position } from '../../lib/types'

type Props = {
  listId: string
  packages: SubcontractPackage[]
  demoNames?: Record<string, SubName>
  positions: Position[]
  /** catalogue price suggestions for unpriced positions (pending confirmation) */
  pending: ReadonlyMap<string, PriceSuggestion>
  onSubcontractors: () => void
  /** switches to X83 with the "pending confirmation" filter */
  onReviewAi: () => void
}

type Own = { amount: number; priced: number; sure: number; ai: number; none: number; sureIds: string[] }

const emptyOwn = (): Own => ({ amount: 0, priced: 0, sure: 0, ai: 0, none: 0, sureIds: [] })

/** adds one position to the own-items tally: its unit price, else a sure catalogue price, else it is open */
function tally(own: Own, p: Position, pending: ReadonlyMap<string, PriceSuggestion>) {
  const s = pending.get(p.id)
  if (p.up != null) {
    own.priced++
    own.amount += p.up * p.qty
  } else if (s?.unitKnown) {
    own.sure++
    own.sureIds.push(p.id)
    own.amount += s.price * p.qty
  } else if (s) own.ai++
  else own.none++
}

export function OfferTab({ listId, packages, demoNames, positions, pending, onSubcontractors, onReviewAi }: Props) {
  const nameOf = useSubNames(true, demoNames)
  const byId = useMemo(() => new Map(positions.map((p) => [p.id, p])), [positions])

  const model = useMemo(() => {
    const packaged = new Set(packages.flatMap((p) => p.positionIds))
    const chosen = packages.flatMap((pkg) => {
      if (!pkg.chosenId) return []
      const offer = offerOf(pkg, pkg.chosenId)
      const own = emptyOwn()
      for (const id of offer.missing ?? []) {
        const p = byId.get(id)
        if (p) tally(own, p, pending)
      }
      return [{ pkg, subId: pkg.chosenId, amount: offer.amount ?? 0, own }]
    })
    const open = packages.filter((pkg) => !pkg.chosenId)
    const sections = new Map<string, { label: string; own: Own; count: number }>()
    for (const p of positions) {
      if (packaged.has(p.id)) continue
      const top = p.path?.[0]
      const key = top?.oz ?? ''
      const group = sections.get(key) ?? { label: top ? `${top.oz} ${top.label}`.trim() : 'Other positions', own: emptyOwn(), count: 0 }
      tally(group.own, p, pending)
      group.count++
      sections.set(key, group)
    }
    const total = chosen.reduce((s, c) => s + c.amount + c.own.amount, 0) + [...sections.values()].reduce((s, g) => s + g.own.amount, 0)
    const sureIds = [...chosen.flatMap((c) => c.own.sureIds), ...[...sections.values()].flatMap((g) => g.own.sureIds)]
    const aiCount = chosen.reduce((s, c) => s + c.own.ai, 0) + [...sections.values()].reduce((s, g) => s + g.own.ai, 0)
    return { chosen, open, sections: [...sections.values()], total, sureIds, aiCount }
  }, [packages, positions, pending, byId])

  const prefill = () => {
    const ids = model.sureIds
    if (!ids.length) return
    const before = useStore.getState().edits[listId]?.up ?? {}
    for (const id of ids) useStore.getState().setUp(listId, id, pending.get(id)!.price)
    // undo puts back only these prices, so edits made after prefilling survive
    toast(`Prefilled ${plural(ids.length, 'price', 'prices')} from the database`, 'ok', {
      label: 'Undo',
      run: () => {
        const e = useStore.getState().edits[listId]
        if (!e) return
        const up = { ...e.up }
        for (const id of ids) {
          if (id in before) up[id] = before[id]
          else delete up[id]
        }
        useStore.getState().setEdits(listId, { ...e, up })
      },
    })
  }

  const empty = model.chosen.length === 0 && model.open.length === 0 && model.sections.length === 0

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" icon="done_all" onClick={prefill} disabled={model.sureIds.length === 0}>
          Prefill {int(model.sureIds.length)} sure {model.sureIds.length === 1 ? 'price' : 'prices'}
        </Button>
        <Button icon="fact_check" onClick={onReviewAi} disabled={model.aiCount === 0}>
          Review AI checks{model.aiCount > 0 && <span className="num ml-1.5 font-medium text-slate-600">{int(model.aiCount)}</span>}
        </Button>
        <span className="text-sm text-slate-600">Nothing is applied until you click Prefill.</span>
      </div>

      {empty && <p className="rounded-lg bg-slate-50 px-5 py-6 text-sm text-slate-700">This list has no positions yet.</p>}

      {model.chosen.map(({ pkg, subId, amount, own }) => (
        <Group key={pkg.id} icon="check_circle" title={pkg.name}>
          <Line label={<>Subcontractor · <span className="font-medium text-slate-900">{nameOf(subId).name}</span></>} amount={amount} strong />
          {(offerOf(pkg, subId).missing?.length ?? 0) > 0 && (
            <Line label="Own items · from database" detail={breakdown(own)} amount={own.amount} />
          )}
        </Group>
      ))}

      {model.open.map((pkg) => (
        <Group key={pkg.id} icon="radio_button_unchecked" title={pkg.name} muted>
          <p className="text-sm text-slate-600">
            No subcontractor chosen yet.{' '}
            <button type="button" onClick={onSubcontractors} className="font-medium text-slate-800 underline decoration-slate-400 underline-offset-4 hover:text-slate-900">Go to Subcontractors</button>
          </p>
        </Group>
      ))}

      {model.sections.map((g) => (
        <Group key={g.label} icon="inventory_2" title={g.label}>
          <Line label="Own items · from database" detail={breakdown(g.own)} amount={g.own.amount} />
        </Group>
      ))}

      <div className="flex flex-wrap items-baseline justify-end gap-x-4 gap-y-1 border-t border-slate-200 pt-4">
        <span className="text-sm font-semibold text-slate-800">Offer total</span>
        <span className="num text-xl font-bold text-slate-900 sm:text-[28px]">{money(model.total)}</span>
      </div>
    </div>
  )
}

function breakdown(o: Own): string {
  const parts = [
    `${int(o.priced)} priced`,
    `${int(o.sure)} from database (sure)`,
    `${int(o.ai)} need AI check`,
    `${int(o.none)} not priced`,
  ]
  return parts.join(' · ')
}

function Group({ icon, title, muted, children }: { icon: string; title: string; muted?: boolean; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-1.5">
      <h3 className={clsx('flex items-center gap-2 font-heading text-[15px] font-bold', muted ? 'text-slate-600' : 'text-slate-900')}>
        <Icon name={icon} size={18} fill={icon === 'check_circle'} className={icon === 'check_circle' ? 'text-emerald-700' : 'text-slate-500'} />
        {title}
      </h3>
      <div className="space-y-1.5 pl-7">{children}</div>
    </section>
  )
}

function Line({ label, detail, amount, strong }: { label: ReactNode; detail?: string; amount: number; strong?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4">
      <div className="min-w-0 text-sm text-slate-700">
        {label}
        {detail && <div className="num text-[13px] text-slate-600">{detail}</div>}
      </div>
      <span className={clsx('num text-sm', strong ? 'font-bold text-emerald-800' : 'font-semibold text-slate-900')}>{money(amount)}</span>
    </div>
  )
}
