import { Button, Icon, inputCls } from '../ui'
import { amount, money, qty } from '../../lib/format'
import type { Position } from '../../lib/types'

/** step 3: our own expected cost for the package. Internal: never written into a file or an email. */
export function CostPane({
  rows, text, onText, sum, totalText, totalOverridden, onTotal, onResetTotal, notes, onNotes,
}: {
  rows: Position[]
  /** what the cost field of a position shows */
  text: (id: string) => string
  onText: (id: string, value: string) => void
  /** sum of the per-position costs */
  sum: number
  totalText: string
  totalOverridden: boolean
  onTotal: (value: string) => void
  onResetTotal: () => void
  notes: string
  onNotes: (value: string) => void
}) {
  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700" data-testid="sc-internal-note">
        <Icon name="lock" size={15} />
        Internal, not sent. This cost never appears in the file or in the email.
      </p>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-center text-sm text-slate-600">Select positions first.</p>
      ) : (
        <div className="max-h-56 overflow-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-50 text-left text-[11px] text-slate-600">
              <tr>
                <th scope="col" className="px-3 py-1.5 font-semibold">Position</th>
                <th scope="col" className="px-2 py-1.5 text-right font-semibold">Quantity</th>
                <th scope="col" className="w-36 px-3 py-1.5 text-right font-semibold">Expected cost (€)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="max-w-0 px-3 py-1">
                    <span className="mr-2 font-mono text-slate-500">{p.oz}</span>
                    <span className="truncate text-slate-700" title={p.short}>{p.short}</span>
                  </td>
                  <td className="px-2 py-1 text-right font-mono whitespace-nowrap text-slate-600">{qty(p.qty)} {p.unit}</td>
                  <td className="px-3 py-1">
                    <input
                      inputMode="decimal"
                      aria-label={`Expected cost of ${p.oz}`}
                      value={text(p.id)}
                      onChange={(e) => onText(p.id, e.target.value)}
                      placeholder="–"
                      className={`${inputCls} h-8 text-right font-mono text-xs`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <label className="block space-y-1">
          <span className="flex items-center justify-between text-[11px] font-semibold text-slate-600">
            <span>Package total, expected (€)</span>
            {totalOverridden && <Button size="sm" variant="ghost" onClick={onResetTotal}>Use sum ({money(sum)})</Button>}
          </span>
          <input inputMode="decimal" aria-label="Expected cost, package total" value={totalText} onChange={(e) => onTotal(e.target.value)} placeholder={amount(sum)} className={`${inputCls} text-right font-mono`} />
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] font-semibold text-slate-600">Internal note (not sent)</span>
          <input aria-label="Internal note" value={notes} onChange={(e) => onNotes(e.target.value)} maxLength={300} placeholder="e.g. price basis, who negotiates" className={inputCls} />
        </label>
      </div>
    </div>
  )
}
