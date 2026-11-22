import { inferLineType, LINE_TYPE_LABELS, parseLineType, type LineType, type LineTypeSetting } from '../lib/line-type'
import { inputCls } from './ui'

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
      <option value="automatic">{suggestion ? 'Automatic suggestion' : 'From description'} ({LINE_TYPE_LABELS[suggestion ?? inferLineType(short, long)]})</option>
      <LineTypeOptions />
    </select>
  )
}
