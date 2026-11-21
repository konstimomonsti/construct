import clsx from 'clsx'
import { Button, Icon, inputCls } from '../ui'
import { FORMAT_LABEL, mailtoLink, type SubcontractFormat } from '../../lib/subcontract'
import type { Recipient } from '../../lib/subcontract-send'

const FORMATS: { id: SubcontractFormat; icon: string; title: string; note: string }[] = [
  { id: 'x83', icon: 'code', title: 'GAEB X83', note: 'The standard request format, without prices. Opens in any AVA program.' },
  { id: 'xlsx', icon: 'grid_on', title: 'Excel', note: 'Empty unit-price cells, line totals as formulas.' },
  { id: 'pdf', icon: 'picture_as_pdf', title: 'PDF', note: 'A printout to read, not to fill in.' },
]

/** step 4: deadline, file format and the German email text */
export function SendPane({
  dueDate, onDueDate, format, onFormat, subject, body, bodyEdited, onBody, onResetBody, sender, onSender,
  recipients, textFor, onCopy, salutationFor,
}: {
  dueDate: string
  onDueDate: (v: string) => void
  format: SubcontractFormat
  onFormat: (f: SubcontractFormat) => void
  subject: string
  body: string
  bodyEdited: boolean
  onBody: (v: string) => void
  onResetBody: () => void
  sender: string
  onSender: (v: string) => void
  recipients: Recipient[]
  /** the complete text of the email to one recipient */
  textFor: (r: Recipient) => string
  onCopy: (r: Recipient) => void
  salutationFor: (r: Recipient) => string
}) {
  const first = recipients[0]
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
        <label className="block space-y-1">
          <span className="text-[11px] font-semibold text-slate-600">Offer deadline</span>
          <input type="date" aria-label="Offer deadline" value={dueDate} onChange={(e) => onDueDate(e.target.value)} className={inputCls} />
        </label>
        <fieldset className="space-y-1" aria-label="File format">
          <legend className="text-[11px] font-semibold text-slate-600">File format</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={format === f.id}
                title={FORMAT_LABEL[f.id]}
                onClick={() => onFormat(f.id)}
                className={clsx(
                  'flex flex-col items-start gap-0.5 rounded-lg border p-2 text-left transition-colors',
                  format === f.id ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-slate-200 bg-white hover:bg-slate-50',
                )}
              >
                <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-800"><Icon name={f.icon} size={15} className="text-slate-600" />{f.title}</span>
                <span className="text-[11px] leading-snug text-slate-600">{f.note}</span>
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold text-slate-600">Email text (German, editable)</span>
          {bodyEdited && <Button size="sm" variant="ghost" onClick={onResetBody}>Reset text</Button>}
        </div>
        <div className="rounded-lg border border-slate-200 bg-white">
          <p className="truncate border-b border-slate-100 px-3 py-1.5 text-xs text-slate-600" data-testid="sc-subject"><span className="font-semibold">Subject:</span> {subject}</p>
          <p className="px-3 pt-2 text-xs text-slate-500" title="Each draft gets its own salutation">{first ? salutationFor(first) : 'Sehr geehrte Damen und Herren,'}</p>
          <textarea aria-label="Email text" value={body} onChange={(e) => onBody(e.target.value)} rows={11} className="block w-full resize-y bg-transparent px-3 py-1.5 text-sm leading-relaxed text-slate-900 outline-none" />
          <textarea aria-label="Sender block" value={sender} onChange={(e) => onSender(e.target.value)} rows={5} className="block w-full resize-y border-t border-slate-100 bg-transparent px-3 py-2 text-sm leading-relaxed text-slate-900 outline-none" />
        </div>
        <p className="text-[11px] text-slate-600">The sender block is remembered on this computer. The email never contains internal cost estimates.</p>
      </div>

      {recipients.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-[11px] font-semibold text-slate-600">Without the file: copy the text or open your mail program</span>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            {recipients.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate font-semibold text-slate-700">{r.name}</span>
                <Button size="sm" icon="content_copy" onClick={() => onCopy(r)} aria-label={`Copy email text for ${r.name}`}>Copy email text</Button>
                <a
                  href={mailtoLink(r.email, subject, textFor(r))}
                  aria-label={`Open mailto link for ${r.name}`}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-semibold text-slate-700 hover:bg-slate-100"
                >
                  <Icon name="mail" size={16} />mailto
                </a>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-slate-600">A mailto link cannot carry the attachment. Use “Export &amp; draft email” to get drafts with the file attached.</p>
        </div>
      )}
    </div>
  )
}
