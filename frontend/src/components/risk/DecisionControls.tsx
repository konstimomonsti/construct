import { Button, Menu } from '../ui'
import { REASONS, type Decision, type DecisionReason } from '../../lib/risk-assessment'

const now = () => new Date().toISOString()

export const dismissWith = (reason: DecisionReason, note?: string): Decision => ({ status: 'dismissed', reason, ...(note ? { note } : {}), at: now() })
export const accepted = (): Decision => ({ status: 'accepted', at: now() })

/** the reason picker behind every Dismiss button */
export function DismissMenu({ label, onDismiss, children, size = 'sm' }: { label: string; onDismiss: (decision: Decision) => void; children?: string; size?: 'sm' | 'md' }) {
  return (
    <Menu
      label={label}
      align="start"
      width="w-60"
      items={(Object.keys(REASONS) as DecisionReason[]).map((reason) => ({
        label: REASONS[reason],
        onSelect: () => {
          const note = reason === 'other' ? window.prompt('Why is this dismissed?')?.trim() : undefined
          onDismiss(dismissWith(reason, note))
        },
      }))}
      trigger={(p) => <Button {...p} size={size} icon="block" aria-label={label}>{children ?? 'Dismiss'}</Button>}
    />
  )
}

/** Accept / Dismiss (with a reason) for an open item, Reopen for a decided one */
export function DecisionControls({ title, decision, onDecide, className }: { title: string; decision?: Decision; onDecide: (decision: Decision | null) => void; className?: string }) {
  if (decision) {
    return (
      <div className={className}>
        <Button size="sm" icon="undo" data-review="done" aria-label={`Reopen: ${title}`} onClick={() => onDecide(null)}>Reopen</Button>
      </div>
    )
  }
  return (
    <div className={['flex flex-wrap gap-2', className].filter(Boolean).join(' ')}>
      <Button size="sm" icon="check" data-review="open" aria-label={`Accept: ${title}`} onClick={() => onDecide(accepted())}>Accept</Button>
      <DismissMenu label={`Dismiss: ${title}`} onDismiss={onDecide} />
    </div>
  )
}
