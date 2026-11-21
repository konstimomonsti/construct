import { useMemo, useState, type ReactNode } from 'react'
import { Button, Dialog, toast } from '../ui'
import type { SubName } from './names'
import { downloadResult, layoutLoader } from '../../lib/export/index'
import { deDate } from '../../lib/export/util'
import { plural, qty } from '../../lib/format'
import {
  composeEmail, emailBody, emailSubject, FORMAT_LABEL, salutation, toRequest, type SubcontractPackage,
} from '../../lib/subcontract'
import { buildRequestFile, loadSender, projectName } from '../../lib/subcontract-send'
import type { CategoryNode, ListDoc, Position } from '../../lib/types'

type Resolved = { positions: Position[]; tree: CategoryNode[] }

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-slate-600">{label}</dt>
      <dd className="text-sm text-slate-900">{children}</dd>
    </div>
  )
}

/**
 * What went out to one category's subcontractors: the same file and email for all of them. Internal data (budget,
 * notes) is never shown here, and the file is rebuilt from `toRequest`, so it cannot carry any either.
 */
export function RequestDialog({ pkg, doc, resolved, nameOf, onClose }: {
  pkg: SubcontractPackage
  doc: ListDoc
  resolved: Resolved
  nameOf: (id: string) => SubName
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const project = projectName(doc)
  const positions = useMemo(() => {
    const ids = new Set(pkg.positionIds)
    return resolved.positions.filter((p) => ids.has(p.id))
  }, [pkg.positionIds, resolved.positions])
  const rebuilt = pkg.sentText == null
  const text = useMemo(
    () => pkg.sentText ?? composeEmail({
      salutation: salutation(),
      body: emailBody({ project, packageName: pkg.name, positionCount: pkg.positionIds.length, dueDate: pkg.dueDate, format: pkg.format }),
      sender: loadSender(),
    }),
    [pkg.sentText, pkg.name, pkg.positionIds.length, pkg.dueDate, pkg.format, project],
  )

  const download = async () => {
    setBusy(true)
    try {
      const file = await buildRequestFile({ doc, resolved, request: toRequest(pkg), loadLayout: pkg.format === 'pdf' ? layoutLoader(doc) : undefined })
      downloadResult({ data: file.data, fileName: file.fileName, mime: file.mime, mode: 'generated' })
    } catch (e) {
      toast(`The request file could not be built: ${(e as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Request: ${pkg.name}`}
      description="The same file and email went to everyone in this category."
      width="max-w-2xl"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" icon="download" onClick={() => void download()} disabled={busy || positions.length === 0}>
            {busy ? 'Building…' : 'Download request file'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Item label="Sent">{pkg.sentAt ? <span className="num">{deDate(pkg.sentAt)}</span> : <span className="text-slate-600">Not sent yet</span>}</Item>
          <Item label="Due">{pkg.dueDate ? <span className="num">{deDate(pkg.dueDate)}</span> : <span className="text-slate-600">No deadline</span>}</Item>
          <Item label="Format">{FORMAT_LABEL[pkg.format]}</Item>
          <div className="col-span-2 min-w-0 sm:col-span-3">
            <dt className="text-xs text-slate-600">Recipients</dt>
            <dd className="text-sm text-slate-900">
              {pkg.subcontractorIds.length === 0 ? <span className="text-slate-600">None</span> : (
                <ul className="mt-0.5 space-y-0.5">
                  {pkg.subcontractorIds.map((id) => {
                    const who = nameOf(id)
                    return <li key={id}><span className="font-medium">{who.name}</span>{who.email && <span className="text-slate-600"> · {who.email}</span>}</li>
                  })}
                </ul>
              )}
            </dd>
          </div>
        </dl>

        <section aria-label="Email">
          <h4 className="text-sm font-semibold text-slate-800">Email</h4>
          <p className="mt-1 text-[13px] text-slate-700"><span className="font-semibold">Subject:</span> <span lang="de">{emailSubject(pkg.name, project)}</span></p>
          <pre lang="de" className="mt-2 max-h-64 overflow-y-auto rounded-md bg-slate-50 px-3 py-2.5 font-sans text-sm leading-relaxed whitespace-pre-wrap text-slate-900">{text.trim()}</pre>
          {rebuilt && <p className="mt-1 text-xs text-slate-600">Rebuilt from the template: this request was saved before the sent text was kept.</p>}
        </section>

        <section aria-label="Positions in the request">
          <h4 className="text-sm font-semibold text-slate-800">{plural(positions.length, 'position', 'positions')}</h4>
          <ul className="mt-1.5 max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-md ring-1 ring-slate-200">
            {positions.map((p) => (
              <li key={p.id} className="flex items-baseline gap-3 px-3 py-1.5 text-sm">
                <span className="num w-20 shrink-0 font-mono text-[13px] text-slate-700">{p.oz}</span>
                <span lang="de" className="min-w-0 flex-1 truncate text-slate-900" title={p.short}>{p.short}</span>
                <span className="num shrink-0 text-slate-700">{qty(p.qty)} {p.unit}</span>
              </li>
            ))}
            {positions.length === 0 && <li className="px-3 py-2 text-sm text-slate-600">The positions of this request are no longer in the list.</li>}
          </ul>
        </section>
      </div>
    </Dialog>
  )
}
