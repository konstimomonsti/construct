import { useEffect, useState } from 'react'
import { Icon } from './ui'

const fmt = (n: number) => String(Math.round(n * 1000) / 1000)
const round = (n: number) => Math.round(n * 1000) / 1000

export function QtyStepper({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  const [text, setText] = useState(fmt(value))
  useEffect(() => setText(fmt(value)), [value])

  const commit = () => {
    const n = Number(text.replace(',', '.'))
    if (Number.isFinite(n) && n >= 0) {
      if (n !== value) onChange(round(n))
      setText(fmt(n))
    } else setText(fmt(value))
  }

  return (
    <div className="inline-flex h-9 items-center gap-0.5 rounded-lg border border-slate-200 bg-slate-100 p-1">
      <button
        type="button"
        aria-label={`Decrease quantity of ${label}`}
        disabled={value <= 0}
        onClick={() => onChange(Math.max(0, round(value - 1)))}
        className="flex size-6 items-center justify-center rounded text-slate-500 transition-colors hover:bg-white hover:text-slate-900 disabled:opacity-40"
      >
        <Icon name="remove" size={14} />
      </button>
      <input
        inputMode="decimal"
        aria-label={`Quantity of ${label}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setText(fmt(value))
            e.currentTarget.blur()
          }
        }}
        onFocus={(e) => e.currentTarget.select()}
        className="h-7 w-11 rounded border border-slate-300 bg-white text-center font-mono text-xs font-bold text-slate-900 focus:outline-none"
      />
      <button
        type="button"
        aria-label={`Increase quantity of ${label}`}
        onClick={() => onChange(round(value + 1))}
        className="flex size-6 items-center justify-center rounded text-slate-500 transition-colors hover:bg-white hover:text-slate-900"
      >
        <Icon name="add" size={14} />
      </button>
    </div>
  )
}
