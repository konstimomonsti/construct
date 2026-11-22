import { clsx } from 'clsx'
import { inferLineType, LINE_TYPE_LABELS, lineTypeOf, parseLineType, type LineType, type LineTypeSetting } from '../lib/line-type'
import type { Position } from '../lib/types'
import { inputCls } from './ui'

const tone = {
  activity: 'bg-sky-50 text-sky-800',
  material: 'bg-emerald-50 text-emerald-800',
  combined: 'bg-violet-50 text-violet-800',
  unclassified: 'bg-slate-100 text-slate-600',
}

export function LineTypeBadge({ position, suggestion }: { position: Position; suggestion?: LineType }) {
  const type = lineTypeOf(position, suggestion)
  const automatic = position.lineType == null || position.lineType === 'automatic'
  const source = suggestion ? 'Suggested by Claude Haiku 5.5' : type !== 'unclassified' ? 'Suggested from the description' : undefined
  return <span className={clsx('rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight', tone[type])}
    title={automatic ? source : undefined}>
    {LINE_TYPE_LABELS[type]}
  </span>
}

export function LineTypeOptions() {
  return Object.entries(LINE_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)
}

export function LineTypeSelect({ value, short, long, suggestion, onChange }: {
  value?: LineTypeSetting
  short: string
  long?: string
  suggestion?: LineType
  onChange: (value: LineTypeSetting) => void
}) {
  return (
    <select className={inputCls} value={value ?? 'automatic'} onChange={(e) => onChange(parseLineType(e.target.value) ?? 'automatic')}>
      <option value="automatic">{suggestion ? 'Claude Haiku 5.5' : 'From description'} ({LINE_TYPE_LABELS[suggestion ?? inferLineType(short, long)]})</option>
      <LineTypeOptions />
    </select>
  )
}
