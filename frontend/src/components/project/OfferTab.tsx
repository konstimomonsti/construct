import { clsx } from 'clsx'
import { useMemo, type ReactNode } from 'react'
import { Button, Icon, toast } from '../ui'
import { useSubNames, type SubName } from './names'
import { downloadResult, exportList } from '../../lib/export/index'
import { int, money, plural } from '../../lib/format'
import { offerModel, offerPositions, type Tally } from '../../lib/offer-x84'
import type { PriceSuggestion } from '../../lib/price-suggestions'
import { useStore } from '../../lib/store'
import type { SubcontractPackage } from '../../lib/subcontract'
import type { CategoryNode, ListDoc, Position } from '../../lib/types'

type Props = {
  listId: string
  doc: ListDoc
  tree: CategoryNode[]
  packages: SubcontractPackage[]
  demoNames?: Record<string, SubName>
  positions: Position[]
  /** catalogue price suggestions for unpriced positions (pending confirmation) */
  pending: ReadonlyMap<string, PriceSuggestion>
  onSubcontractors: () => void
  /** switches to X83 with the "pending confirmation" filter */
  onReviewAi: () => void
}

export function OfferTab({ listId, doc, tree, packages, demoNames, positions, pending, onSubcontractors, onReviewAi }: Props) {
  const nameOf = useSubNames(true, demoNames)
  const model = useMemo(() => offerModel(positions, packages, pending), [packages, positions, pending])
  const dbCount = model.apply.filter((a) => a.source === 'db').length
  const subCount = model.apply.length - dbCount

  const apply = () => {
    const items = model.apply
    if (!items.length) return
    const before = useStore.getState().edits[listId]?.up ?? {}
    for (const a of items) useStore.getState().setUp(listId, a.id, a.price)
    // undo puts back only these prices, so edits made after applying survive
    toast(`Applied ${plural(items.length, 'price', 'prices')}`, 'ok', {
      label: 'Undo',
      run: () => {
        const e = useStore.getState().edits[listId]
        if (!e) return
        const up = { ...e.up }
        for (const { id } of items) {
          if (id in before) up[id] = before[id]
          else delete up[id]
        }
        useStore.getState().setEdits(listId, { ...e, up })
      },
    })
  }

  const exportX84 = async () => {
    try {
      const res = await exportList({ doc, resolved: { positions: offerPositions(positions, packages, pending), tree }, format: 'x84', edited: false })
      downloadResult(res)
      toast(`Exported ${res.fileName}`, 'ok')
    } catch (e) {
      toast(`The X84 could not be exported: ${(e as Error).message}`, 'error')
    }
  }

  const empty = model.chosen.length === 0 && model.open.length === 0 && model.sections.length === 0

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" icon="done_all" onClick={apply} disabled={model.apply.length === 0}>
          Apply {int(model.apply.length)} {model.apply.length === 1 ? 'price' : 'prices'}
          {model.apply.length > 0 && <span className="num ml-1.5 font-normal">({int(subCount)} subcontractor · {int(dbCount)} database)</span>}
        </Button>
        <Button icon="fact_check" onClick={onReviewAi} disabled={model.aiCount === 0}>
          Review AI checks{model.aiCount > 0 && <span className="num ml-1.5 font-medium text-slate-600">{int(model.aiCount)}</span>}
        </Button>
        <Button icon="request_quote" onClick={() => void exportX84()} disabled={positions.length === 0}>Export X84</Button>
        {model.unpriced > 0 && <span className="num text-sm text-amber-800">{int(model.unpriced)} {model.unpriced === 1 ? 'position' : 'positions'} not priced</span>}
      </div>
      <p className="text-sm text-slate-600">Nothing is applied until you click Apply. The X84 uses the same prices as the total below.</p>
      {model.legacyCount > 0 && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {model.legacyCount === 1 ? 'An offer was' : 'Some offers were'} imported without per-position prices. Import the offer file again to apply its prices to positions.
        </p>
      )}

      {empty && <p className="rounded-lg bg-slate-50 px-5 py-6 text-sm text-slate-700">This list has no positions yet.</p>}

      {model.chosen.map(({ pkg, subId, amount, noAmount, own }) => {
        const who = <>Subcontractor · <span className="font-medium text-slate-900">{nameOf(subId).name}</span></>
        const hasOwn = own.priced + own.sub + own.sure + own.ai + own.none > 0
        return (
          <Group key={pkg.id} icon={noAmount ? 'hourglass_empty' : 'check_circle'} title={pkg.name} muted={noAmount}>
            {noAmount ? <Line label={who} text="No amount yet" /> : <Line label={who} amount={amount} strong />}
            {hasOwn && <Line label="Own items" detail={breakdown(own)} amount={own.amount} />}
          </Group>
        )
      })}

      {model.open.map(({ pkg, own }) => (
        <Group key={pkg.id} icon="radio_button_unchecked" title={pkg.name} muted>
          <p className="text-sm text-slate-600">
            No subcontractor chosen yet · own prices counted{' '}
            <button type="button" onClick={onSubcontractors} className="font-medium text-slate-800 underline decoration-slate-400 underline-offset-4 hover:text-slate-900">Go to Subcontractors</button>
          </p>
          <Line label="Own items" detail={breakdown(own)} amount={own.amount} />
        </Group>
      ))}

      {model.sections.map((g) => (
        <Group key={g.label} icon="inventory_2" title={g.label}>
          <Line label="Own items" detail={breakdown(g.own)} amount={g.own.amount} />
        </Group>
      ))}

      <div className="flex flex-wrap items-baseline justify-end gap-x-4 gap-y-1 border-t border-slate-200 pt-4">
        <span className="text-sm font-semibold text-slate-800">Offer total</span>
        <span className="num text-xl font-bold text-slate-900 sm:text-[28px]">{money(model.total)}</span>
      </div>
    </div>
  )
}

function breakdown(o: Tally): string {
  const parts = [
    `${int(o.priced)} priced`,
    ...(o.sub > 0 ? [`${int(o.sub)} from subcontractor`] : []),
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

function Line({ label, detail, amount, text, strong }: { label: ReactNode; detail?: string; amount?: number; text?: string; strong?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4">
      <div className="min-w-0 text-sm text-slate-700">
        {label}
        {detail && <div className="num text-[13px] text-slate-600">{detail}</div>}
      </div>
      {text != null
        ? <span className="text-sm text-slate-600">{text}</span>
        : <span className={clsx('num text-sm', strong ? 'font-bold text-emerald-800' : 'font-semibold text-slate-900')}>{money(amount ?? 0)}</span>}
    </div>
  )
}
