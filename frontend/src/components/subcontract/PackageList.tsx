import clsx from 'clsx'
import { Button, Icon } from '../ui'
import { money, plural } from '../../lib/format'
import { deDate } from '../../lib/export/util'
import { FORMAT_LABEL, type SubcontractPackage, type SubcontractStatus } from '../../lib/subcontract'

const STATUS: Record<SubcontractStatus, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'bg-slate-100 text-slate-700' },
  sent: { label: 'Sent', cls: 'bg-sky-50 text-sky-800' },
  offer_received: { label: 'Offer received', cls: 'bg-emerald-50 text-emerald-800' },
}

/** the packages of this list: status, recipients, internal budget and what can be done next */
export function PackageList({
  packages, nameOf, onReexport, onReceived, onMarkSent, onDelete, onNew,
}: {
  packages: SubcontractPackage[]
  /** a subcontractor's name from its catalogue id */
  nameOf: (id: string) => string | undefined
  onReexport: (p: SubcontractPackage) => void
  onReceived: (p: SubcontractPackage) => void
  /** the email of a draft package went out from the mail program */
  onMarkSent: (p: SubcontractPackage) => void
  onDelete: (p: SubcontractPackage) => void
  onNew: () => void
}) {
  if (!packages.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-12 text-center text-sm text-slate-600" data-testid="sc-empty">
        <Icon name="engineering" size={32} className="text-slate-300" />
        <p>No subcontract packages for this list yet.</p>
        <Button variant="primary" icon="add" onClick={onNew}>New request</Button>
      </div>
    )
  }
  return (
    <ul className="divide-y divide-slate-100" aria-label="Subcontract packages">
      {packages.map((p) => {
        const names = p.subcontractorIds.map((id) => nameOf(id)).filter((n): n is string => !!n)
        const unknown = p.subcontractorIds.length - names.length
        const st = STATUS[p.status]
        return (
          <li key={p.id} data-testid="sc-package" data-status={p.status} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
            <div className="min-w-0 flex-1 basis-64 space-y-1">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-slate-900">{p.name}</span>
                <span className={clsx('rounded-md px-1.5 py-px text-[11px] font-semibold', st.cls)}>
                  {st.label}{p.status === 'sent' && p.sentAt ? ` · ${deDate(p.sentAt.slice(0, 10))}` : ''}
                </span>
              </p>
              <p className="text-xs text-slate-600">
                {plural(p.positionIds.length, 'position', 'positions')} · {FORMAT_LABEL[p.format]}
                {p.dueDate ? ` · due ${deDate(p.dueDate)}` : ''}
              </p>
              <p className="text-xs text-slate-600">
                {names.length || unknown ? `${names.join(', ')}${unknown ? `${names.length ? ', ' : ''}${plural(unknown, 'other', 'others')}` : ''}` : 'No subcontractor chosen'}
              </p>
              {p.notes && <p className="text-xs text-slate-500 italic">{p.notes}</p>}
            </div>
            <div className="w-40 shrink-0 text-right" title="Internal, not sent">
              <p className="font-mono text-sm font-semibold text-slate-900">{p.budget.total > 0 ? money(p.budget.total) : '—'}</p>
              <p className="flex items-center justify-end gap-1 text-[11px] text-slate-500"><Icon name="lock" size={12} />Expected cost, internal</p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" icon="forward_to_inbox" onClick={() => onReexport(p)}>{p.status === 'draft' ? 'Edit & send' : 'Re-export / new draft'}</Button>
              {p.status === 'draft' && <Button size="sm" icon="mark_email_read" onClick={() => onMarkSent(p)} title="The email is already sent from your mail program" data-testid="sc-package-mark-sent">Mark as sent</Button>}
              {p.status !== 'offer_received' && <Button size="sm" icon="task_alt" onClick={() => onReceived(p)}>Mark offer received</Button>}
              <Button size="sm" variant="ghost" icon="delete" aria-label={`Delete ${p.name}`} onClick={() => onDelete(p)} className="text-rose-700 hover:bg-rose-50" />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
