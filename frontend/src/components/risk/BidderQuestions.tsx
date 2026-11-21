import { Button, toast } from '../ui'
import { int } from '../../lib/format'
import type { Decisions, Question } from '../../lib/risk-assessment'
import { downloadBytes, questionsMarkdown } from '../../lib/risk-export'

/** questions whose source findings are not all dismissed */
export const openQuestions = (questions: Question[], decisions: Decisions) =>
  questions.filter((q) => !q.finding_ids.length || q.finding_ids.some((id) => decisions[id]?.status !== 'dismissed'))

/** Bieterfragen: numbered, editable, copied or downloaded as a German e-mail */
export function BidderQuestions({ title, questions, texts, onEdit }: {
  title: string
  questions: Question[]
  texts: Record<string, string>
  onEdit: (id: string, text: string) => void
}) {
  const all = questions.map((q) => texts[q.id] ?? q.text_de)
  const email = () => questionsMarkdown(title, all)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(email())
      toast(`Copied ${int(questions.length)} questions`)
    } catch {
      toast('Copying is blocked in this browser', 'error')
    }
  }
  const slug = title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'liste'
  return (
    <section aria-labelledby="questions-h" className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="questions-h" className="font-heading text-base font-bold text-slate-900">
          Bieterfragen<span className="num ml-2 font-sans text-sm font-medium text-slate-600">{int(questions.length)}</span>
        </h2>
        {questions.length > 0 && (
          <div className="flex gap-2">
            <Button icon="content_copy" onClick={copy}>Copy all</Button>
            <Button icon="download" onClick={() => downloadBytes(`Bieterfragen-${slug}.md`, email(), 'text/markdown;charset=utf-8')}>Download .md</Button>
          </div>
        )}
      </div>
      {questions.length ? (
        <ol className="mt-3 space-y-4">
          {questions.map((q, i) => (
            <li key={q.id} className="flex gap-3">
              <span className="num w-6 shrink-0 pt-2 text-sm font-semibold text-slate-600">{i + 1}.</span>
              <label className="min-w-0 flex-1">
                <span className="text-[13px] font-semibold text-slate-600">{q.topic} · <span className="num">{q.line_codes.join(', ')}</span></span>
                <textarea
                  lang="de"
                  value={all[i]}
                  onChange={(e) => onEdit(q.id, e.target.value)}
                  rows={3}
                  className="mt-1 block w-full resize-y rounded-md bg-white px-3 py-2 text-sm leading-relaxed text-slate-900 ring-1 ring-slate-400 outline-none ring-inset focus:ring-2 focus:ring-brand-600"
                />
              </label>
            </li>
          ))}
        </ol>
      ) : <p className="mt-2 text-sm text-slate-600">No open questions for the client.</p>}
    </section>
  )
}
