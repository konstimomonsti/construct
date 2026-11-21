import { Button, Icon, toast } from '../ui'
import { plural } from '../../lib/format'
import type { Question } from '../../lib/risk-assessment'
import { downloadBytes, questionsMarkdown } from '../../lib/risk-export'

/** Client-facing drafts linked to the finding the estimator is reviewing. */
export function FindingQuestions({ title, questions }: {
  title: string
  questions?: Question[]
}) {
  if (!questions?.length) return null
  const draft = questionsMarkdown(title, questions.map((question) => question.text_de))
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft)
      toast('Clarification draft copied')
    } catch {
      toast('Clipboard unavailable. Download the draft instead.', 'error')
    }
  }
  const slug = title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'liste'
  return (
    <details className="group/clarification mt-3 ml-[15px] rounded-md border border-slate-200 bg-slate-50">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-md px-3 text-sm font-semibold text-slate-800 hover:bg-slate-100 [&::-webkit-details-marker]:hidden">
        <Icon name="chevron_right" size={17} className="shrink-0 transition-transform group-open/clarification:rotate-90" />
        {plural(questions.length, 'client clarification draft', 'client clarification drafts')}
      </summary>
      <div className="space-y-3 border-t border-slate-200 px-3 py-3">
        <ul lang="de" className="space-y-2 text-sm leading-relaxed text-slate-800">
          {questions.map((question) => <li key={question.id}>{question.text_de}</li>)}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon="content_copy" onClick={copy}>Copy email draft</Button>
          <Button size="sm" variant="ghost" icon="download"
            onClick={() => downloadBytes(`Bieterfragen-${slug}.txt`, draft, 'text/plain;charset=utf-8')}>Download draft</Button>
        </div>
      </div>
    </details>
  )
}
