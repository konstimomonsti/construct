import { useId, useState, type FormEvent } from 'react'
import { Button, Dialog, Icon, inputCls } from './ui'
import { bidAssumptions, bidPricing, type BidPosition, type Change, type Market, type Opportunity, type PricingResult, type PricingTender, type Rates } from '../lib/bid-pricing'
import { inputNumber, parseNumber, pct1, qty } from '../lib/format'

const rateLabels = { cost: 'Unit cost', standard: 'Standard rate', floor: 'Minimum', ceiling: 'Maximum' } as const
const strategies = { standard: 'Standard rates', price_only: 'Price-only', quantity_aware: 'Quantity-aware' } as const
const numberClass = `${inputCls} h-9 min-w-0 text-right tabular-nums`

function NumberField({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (value: string) => void; placeholder?: string
}) {
  return <input type="text" inputMode="decimal" aria-label={label} value={value} placeholder={placeholder}
    onChange={(e) => onChange(e.target.value)} className={numberClass} />
}

export function BidSimulator({ listId, title, standardRates }: {
  listId: string; title: string; standardRates: ReadonlyMap<string, number>
}) {
  const formId = useId()
  const [open, setOpen] = useState(false)
  const [tender, setTender] = useState<PricingTender>()
  const [rates, setRates] = useState<Record<string, Rates>>({})
  const [markets, setMarkets] = useState<Market[]>([{ id: 1, threshold: '', chance: '100' }])
  const [nextMarket, setNextMarket] = useState(2)
  const [changes, setChanges] = useState<Change[]>([])
  const [correction, setCorrection] = useState('')
  const [result, setResult] = useState<PricingResult>()
  const [view, setView] = useState<'setup' | 'result'>('setup')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const positionByKey = new Map(tender?.positions.map((p) => [p.key, p]))
  const currency = tender?.currency ?? 'EUR'
  const quantityConflicts = (view === 'result' ? result?.quantity_conflicts : undefined) ?? tender?.quantity_conflicts ?? []

  async function load() {
    setBusy(true)
    setError('')
    try {
      const data = await bidPricing<PricingTender>(listId)
      setTender(data)
      const changed = tender?.input_hash !== data.input_hash
      if (changed) {
        setRates(Object.fromEntries(data.positions.map(({key, id}) => {
          const standard = standardRates.get(id)
          return [key, { cost: '', standard: standard == null ? '' : inputNumber(standard), floor: '', ceiling: '' }]
        })))
        setChanges([])
      }
      if (changed || JSON.stringify(tender?.quantity_conflicts ?? []) !== JSON.stringify(data.quantity_conflicts ?? [])) {
        setResult(undefined)
        setView('setup')
      }
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function update(change: () => void) {
    change()
    setError('')
    setResult(undefined)
  }

  function addChange(position: BidPosition, opportunity?: Opportunity) {
    update(() => setChanges((items) => [...items.filter((item) => item.position !== position.key), {
      position: position.key, quantity: opportunity?.quantity.replace('.', ',') ?? '', rule: opportunity?.rule_id,
      share: '', other: '',
    }]))
  }

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!tender || busy) return
    setError('')
    setBusy(true)
    try {
      const data = await bidPricing<PricingResult>(listId, bidAssumptions(tender, rates, markets, changes, correction))
      setResult(data)
      setView('result')
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return <>
    <Button icon="calculate" aria-label="Bid simulator" onClick={() => {
      setOpen(true)
      if (!busy) void load()
    }} className="max-sm:w-10 max-sm:px-0">
      <span className="max-sm:hidden">Bid simulator</span>
    </Button>
    <Dialog open={open} onClose={() => setOpen(false)} title="Bid simulator" width="max-w-5xl"
      description={`${title} · Original tender quantities · Simulation only`}
      footer={tender && <>
        <Button onClick={() => view === 'result' ? setView('setup') : setOpen(false)}>{view === 'result' ? 'Edit assumptions' : 'Close'}</Button>
        {view === 'setup' && <Button type="submit" form={formId} variant="primary" icon="calculate" disabled={busy}>
          {busy ? 'Simulating…' : 'Simulate bid'}
        </Button>}
      </>}>
      {error && <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-900">
        <Icon name="error" size={18} /><div>{error.split('\n')[0]}{!tender && <Button size="sm" onClick={() => void load()} className="ml-2">Retry</Button>}</div>
      </div>}
      {!tender && busy && <div role="status" className="flex items-center gap-2 py-4 text-sm"><Icon className="animate-spin" name="progress_activity" />Loading the original tender…</div>}
      {quantityConflicts.length > 0 && (
        <section aria-label="Quantities to confirm" className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <p className="font-semibold">Quantities to confirm</p>
          <p>The base bid uses the quantities as issued. Resolve each conflict before adding changes to that position.</p>
          <ul className="mt-2 max-h-40 space-y-2 overflow-auto">
            {quantityConflicts.map(({ position, quantity, unit, written }) => (
              <li key={position}>
                <strong>{position}</strong> · Quantity column {quantity} {unit}
                <ul className="ml-4">
                  {written.map(({ quote, quantity: described }, index) => (
                    <li key={index}><q>{quote}</q> gives {described} {unit}.</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}
      {tender && (view === 'result' && result ? <Comparison result={result} positions={tender.positions} /> :
        <form id={formId} onSubmit={run} className="space-y-5">
          <fieldset disabled={busy} className="space-y-5">
            <section className="rounded-lg border border-slate-200">
              <div className="px-4 py-3">
                <h3 className="text-sm font-semibold text-slate-900">Position rates <span className="font-normal text-slate-500">· {currency} per unit</span></h3>
                <p className="mt-0.5 text-xs text-slate-600">Enter direct costs and standard rates. Blank limits fix the rate at its standard value.</p>
              </div>
              <div className="max-h-64 overflow-auto">
                <table className="w-full border-collapse sm:min-w-[600px] text-sm">
                  <thead className="sticky top-0 bg-slate-50 text-xs text-slate-600 max-sm:sr-only">
                    <tr><th scope="col" className="w-[40%] px-4 py-2 text-left font-medium">Tender position</th>
                      {Object.values(rateLabels).map((label) => <th scope="col" key={label} className="px-2 py-2 text-right font-medium">{label}</th>)}</tr>
                  </thead>
                  <tbody>{tender.positions.map((p) => <tr key={p.key} className="border-t border-slate-100 max-sm:grid max-sm:grid-cols-2">
                    <th scope="row" className="px-4 py-2 text-left font-medium text-slate-900 max-sm:col-span-2">
                      <span className="mr-2 text-xs font-normal text-slate-500">{p.key}</span>{p.text || 'Untitled position'}
                      <span className="block text-xs font-normal text-slate-600">{qty(Number(p.quantity))} {p.unit}</span>
                    </th>
                    {(Object.keys(rateLabels) as (keyof Rates)[]).map((key) => <td key={key} className="px-2 py-1.5">
                      <span aria-hidden className="text-xs text-slate-600 sm:hidden">{rateLabels[key]}</span>
                      <NumberField label={`${p.key} ${rateLabels[key]}`} value={rates[p.key][key]} placeholder={key === 'floor' || key === 'ceiling' ? 'Standard' : '—'}
                        onChange={(value) => update(() => setRates((all) => ({ ...all, [p.key]: { ...all[p.key], [key]: value } })))} />
                    </td>)}
                  </tr>)}</tbody>
                </table>
              </div>
            </section>

            <div className="grid gap-4 md:grid-cols-2">
              <section className="min-w-0 rounded-lg border border-slate-200 p-4">
                <h3 className="text-sm font-semibold text-slate-900">Market scenarios</h3>
                <p className="mb-3 mt-0.5 text-xs text-slate-600">A bid wins at or below the award ceiling. Market probabilities must total 100%.</p>
                {markets.map((market, index) => <div key={market.id} className="mb-2 grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                  <label className="text-xs text-slate-700">Award ceiling ({currency})
                    <NumberField label={`Market ${index + 1} award ceiling`} value={market.threshold}
                      onChange={(threshold) => update(() => setMarkets((all) => all.map((m) => m.id === market.id ? { ...m, threshold } : m)))} />
                  </label>
                  <label className="text-xs text-slate-700">Probability (%)
                    <NumberField label={`Market ${index + 1} probability`} value={market.chance}
                      onChange={(chance) => update(() => setMarkets((all) => all.map((m) => m.id === market.id ? { ...m, chance } : m)))} />
                  </label>
                  <Button size="sm" icon="close" aria-label={`Remove market ${index + 1}`} disabled={markets.length === 1}
                    onClick={() => update(() => setMarkets((all) => all.filter(({id}) => id !== market.id)))} />
                </div>)}
                <Button size="sm" icon="add" disabled={markets.length >= 6} onClick={() => update(() => {
                  setMarkets((all) => [...all, { id: nextMarket, threshold: '', chance: '' }])
                  setNextMarket(nextMarket + 1)
                })}>Add market scenario</Button>
              </section>

              <section className="min-w-0 rounded-lg border border-slate-200 p-4">
                <h3 className="text-sm font-semibold text-slate-900">Quantity changes</h3>
                <p className="mb-3 mt-0.5 text-xs text-slate-600">Use a detected shortfall or enter extra units. Selected changes occur together in a correction scenario.</p>
                {tender.opportunities.map((o) => {
                  const position = positionByKey.get(o.position)
                  if (!position) return null
                  const selected = changes.some((c) => c.position === o.position && c.rule === o.rule_id)
                  return <div key={o.finding_id} className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs">
                    <div>
                      <p className="font-semibold text-amber-950">{o.title}</p>
                      <p className="text-amber-900">{o.position} · +{qty(Number(o.quantity))} {position.unit}{o.ai_reviewed ? ' · AI reviewed' : ''}</p>
                    </div>
                    <Button size="sm" onClick={() => addChange(position, o)} disabled={selected}>{selected ? 'Added' : 'Use finding'}</Button>
                  </div>
                })}
                <select className={`${inputCls} h-9 text-sm`} aria-label="Add quantity change" value="" onChange={(e) => {
                  const position = positionByKey.get(e.target.value)
                  if (position) addChange(position)
                }}>
                  <option value="">Add a position manually…</option>
                  {tender.positions.filter((p) => p.can_change_quantity && !changes.some((c) => c.position === p.key))
                    .map((p) => <option key={p.key} value={p.key}>{p.key} · {p.text}</option>)}
                </select>
                {changes.length > 0 && <div className="mt-3 space-y-3">
                  {changes.map((c) => {
                    const edit = (field: 'quantity' | 'share' | 'other', value: string) => update(() =>
                      setChanges((all) => all.map((item) => item.position === c.position
                        ? { ...item, [field]: value, ...(field === 'quantity' && { rule: undefined }) } : item)))
                    return <div key={c.position} className="border-t border-slate-200 pt-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-medium">{c.position} · {positionByKey.get(c.position)?.text}</p>
                        <Button size="sm" icon="close" aria-label={`Remove change ${c.position}`}
                          onClick={() => update(() => setChanges((all) => all.filter((item) => item.position !== c.position)))} />
                      </div>
                      <div className="grid gap-2 sm:grid-cols-3">
                        <label className="text-xs text-slate-700">Extra units<NumberField label={`${c.position} extra quantity`} value={c.quantity} onChange={(v) => edit('quantity', v)} /></label>
                        <label className="text-xs text-slate-700">At bid rate (%)<NumberField label={`${c.position} share at bid rate`} value={c.share} onChange={(v) => edit('share', v)} /></label>
                        {parseNumber(c.share) !== 100 && <label className="text-xs text-slate-700">Other rate ({currency})<NumberField label={`${c.position} other settlement rate`} value={c.other} onChange={(v) => edit('other', v)} /></label>}
                      </div>
                    </div>
                  })}
                  <label className="block max-w-xs text-xs text-slate-700">Chance of quantity correction in each market (%)
                    <NumberField label="Quantity correction chance" value={correction} onChange={(v) => update(() => setCorrection(v))} />
                  </label>
                </div>}
              </section>
            </div>
          </fieldset>
        </form>)}
    </Dialog>
  </>
}

function Comparison({ result, positions }: { result: PricingResult; positions: BidPosition[] }) {
  const formatter = new Intl.NumberFormat('de-DE', { style: 'currency', currency: result.currency })
  const amount = (value: string | null) => value == null ? '—' : formatter.format(Number(value))
  const { standard, price_only: blind, quantity_aware: aware } = result.strategies
  const delta = Number(aware.expected_profit) - Number(blind.expected_profit)
  const gap = Number(aware.optimality_gap_bound)
  const changed = positions.filter(({key}) => aware.rates[key] != null && Number(aware.rates[key]) !== Number(standard.rates[key]))
  return <div className="space-y-5" aria-live="polite">
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">Quantity-aware result</h3>
        <p className="mt-0.5 text-sm text-slate-700">
          {aware.bid_total == null ? 'No bid has a positive modeled return within the evaluated rates.' :
            gap === 0 ? 'Best modeled return within the supplied rate limits.' :
              `A longer search could recover up to ${formatter.format(gap)} in expected profit.`}
        </p>
      </div>
      <div>
        <p className="text-xs text-slate-600">Expected profit vs. price-only</p>
        <p className="num text-xl font-semibold text-brand-900">{delta > 0 ? '+' : ''}{formatter.format(delta)}</p>
      </div>
    </section>
    <div className="space-y-2 sm:hidden">
      {(Object.keys(strategies) as (keyof typeof strategies)[]).map((key) => {
        const s = result.strategies[key]
        return <section key={key} className={`rounded-lg border border-slate-200 p-3 ${key === 'quantity_aware' ? 'bg-brand-50/60' : ''}`}>
          <h4 className="mb-2 text-sm font-semibold">{strategies[key]}</h4>
          <dl className="grid grid-cols-2 gap-2 text-sm tabular-nums">
            <div><dt className="text-xs text-slate-600">Net bid</dt><dd>{s.bid_total == null ? 'No bid' : amount(s.bid_total)}</dd></div>
            <div><dt className="text-xs text-slate-600">Award chance</dt><dd>{pct1(Number(s.win_probability) * 100)}</dd></div>
            <div><dt className="text-xs text-slate-600">Expected profit</dt><dd>{amount(s.expected_profit)}</dd></div>
            <div><dt className="text-xs text-slate-600">Worst awarded profit</dt><dd>{amount(s.worst_awarded_profit)}</dd></div>
          </dl>
        </section>
      })}
    </div>
    <div className="hidden overflow-auto rounded-lg border border-slate-200 sm:block">
      <table aria-label="Pricing strategy comparison" className="w-full min-w-[540px] text-sm tabular-nums">
        <thead className="bg-slate-50 text-xs text-slate-600"><tr>
          <th className="px-4 py-3 text-left" scope="col">Strategy</th>
          <th className="px-3 py-3 text-right" scope="col">Net bid</th>
          <th className="px-3 py-3 text-right" scope="col">Award chance</th>
          <th className="px-3 py-3 text-right" scope="col">Expected profit</th>
          <th className="px-4 py-3 text-right" scope="col">Worst awarded profit</th>
        </tr></thead>
        <tbody>{(Object.keys(strategies) as (keyof typeof strategies)[]).map((key) => {
          const s = result.strategies[key]
          return <tr key={key} className={`border-t border-slate-200 ${key === 'quantity_aware' ? 'bg-brand-50/60 font-semibold' : ''}`}>
            <th scope="row" className="px-4 py-3 text-left font-medium">{strategies[key]}</th>
            <td className="px-3 py-3 text-right">{s.bid_total == null ? 'No bid' : amount(s.bid_total)}</td>
            <td className="px-3 py-3 text-right">{pct1(Number(s.win_probability) * 100)}</td>
            <td className="px-3 py-3 text-right">{amount(s.expected_profit)}</td>
            <td className={`px-4 py-3 text-right ${Number(s.worst_awarded_profit) < 0 ? 'text-rose-800' : ''}`}>{amount(s.worst_awarded_profit)}</td>
          </tr>
        })}</tbody>
      </table>
    </div>
    {changed.length > 0 && <section>
      <h3 className="mb-2 text-sm font-semibold">Suggested rate changes</h3>
      <div className="max-h-60 overflow-auto rounded-lg border border-slate-200">
        <table aria-label="Suggested rate changes" className="w-full text-sm tabular-nums">
          <thead className="sticky top-0 bg-slate-50 text-xs text-slate-600"><tr>
            <th scope="col" className="px-4 py-2.5 text-left">Position</th>
            <th scope="col" className="px-3 py-2.5 text-right">Standard</th>
            <th scope="col" className="px-3 py-2.5 text-right">Quantity-aware</th>
            <th scope="col" className="px-4 py-2.5 text-right">Change per unit</th>
          </tr></thead>
          <tbody>{changed.map(({key, text}) => <tr key={key} className="border-t border-slate-200">
            <th scope="row" className="px-4 py-2.5 text-left font-medium"><span className="mr-2 text-xs text-slate-500">{key}</span>{text}</th>
            <td className="px-3 py-2.5 text-right">{amount(standard.rates[key])}</td>
            <td className="px-3 py-2.5 text-right font-semibold">{amount(aware.rates[key])}</td>
            <td className="px-4 py-2.5 text-right">{formatter.format(Number(aware.rates[key]) - Number(standard.rates[key]))}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>}
    <p className="text-xs text-slate-600">Expected profit weights awarded outcomes by their scenario probabilities. The quote in the workspace is unchanged.</p>
  </div>
}
