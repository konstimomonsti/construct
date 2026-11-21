import { useEffect, useState } from 'react'
import { parseNumber, qty } from '../lib/format'

/**
 * editable numbers (Menge, EP) share one cue: a dotted rule under the field at rest, a field outline while the
 * row is hovered or focused, and always outlined on touch screens where there is no hover.
 */
export const editableCls =
  'num h-9 rounded-md border border-dotted border-transparent px-2 text-right text-sm transition-colors group-hover:border-solid group-hover:border-slate-500 group-hover:bg-white group-focus-within:border-solid group-focus-within:border-slate-500 hover:border-slate-600 focus:border-solid focus:bg-white max-lg:border-solid max-lg:border-slate-400 [@media(pointer:coarse)]:border-solid [@media(pointer:coarse)]:border-slate-400'

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
      className={`${editableCls}${edited ? ' font-semibold text-brand-700' : muted ? ' text-slate-500' : ' text-slate-900'} w-16 outline-none focus:border-transparent focus:bg-white focus:ring-2 focus:ring-brand-700 lg:w-full`}
    />
  )
}
