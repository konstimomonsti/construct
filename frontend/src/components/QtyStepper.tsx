import { useEffect, useState } from 'react'
import { parseNumber, qty } from '../lib/format'

/**
 * editable numbers (Menge, Einheitspreis) always read as fields: a filled box with an outline, so what can be
 * typed into stands apart from the read-only text around it. A hovered row lifts its fields to white.
 */
export const editableCls =
  'num h-9 rounded-md border border-slate-300 bg-slate-100 px-2 text-right text-sm transition-colors group-hover:bg-white hover:border-slate-600 hover:bg-white focus:bg-white'

const round = (n: number) => Math.round(n * 1000) / 1000

/** typed quantity field: dotted underline at rest, a full field on hover/focus; arrows step by 1 */
export function QtyInput({ value, onChange, label, edited, muted }: { value: number; onChange: (n: number) => void; label: string; edited?: boolean; muted?: boolean }) {
  const [text, setText] = useState(qty(value))
  useEffect(() => setText(qty(value)), [value])

  const commit = () => {
    const n = parseNumber(text)
    if (text.trim() !== '' && n !== null && n >= 0) {
      if (round(n) !== value) onChange(round(n))
      setText(qty(round(n)))
    } else setText(qty(value))
  }

  return (
    <input
      inputMode="decimal"
      aria-label={`Quantity of ${label}${edited ? ' (edited)' : ''}`}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setText(qty(value))
          e.currentTarget.blur()
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          onChange(Math.max(0, round(value + (e.key === 'ArrowUp' ? 1 : -1))))
        }
      }}
      onFocus={(e) => e.currentTarget.select()}
      className={`${editableCls}${edited ? ' font-semibold text-brand-700' : muted ? ' text-slate-600' : ' text-slate-900'} w-16 pb-px outline-none focus:border-transparent focus:bg-white focus:ring-2 focus:ring-brand-700 lg:w-full`}
    />
  )
}
