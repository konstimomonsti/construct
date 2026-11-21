import { clsx } from 'clsx'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { pct } from '../lib/format'
import { overallPercent, useImportProgress, type ImportFileProgress, type ImportPhase } from '../lib/import-progress'

const SHOW_AFTER_MS = 600

const PHASE_TEXT: Record<ImportPhase, string> = {
  queued: 'Getting ready…',
  reading: 'Uploading and reading the PDF…',
  building: 'Building the list…',
  done: 'Done',
  failed: 'Could not read this file',
}

/* ---- illustration ---- */

// widths in SVG units: mixer 0..96, gap, semi truck 110..238
const CONVOY_W = 238
const VIEW_W = 400
const STRIPES = [-30, -14, 2, 18, 34, 50, 66, 82]

function Wheel({ cx, spin }: { cx: number; spin: boolean }) {
  return (
    <g className={spin ? 'bb-spin' : undefined} style={{ transformBox: 'fill-box', transformOrigin: 'center' }}>
      <circle cx={cx} cy={119} r={8.5} className="fill-slate-900 stroke-slate-900" strokeWidth={1.5} />
      <circle cx={cx} cy={119} r={3.6} className="fill-slate-300" />
      <line x1={cx - 3.6} y1={119} x2={cx + 3.6} y2={119} className="stroke-brand-600" strokeWidth={1.6} strokeLinecap="round" />
    </g>
  )
}

function Illustration({ percent, finished, failed }: { percent: number; finished: boolean; failed: boolean }) {
  const moving = !finished && !failed
  // the road fill is exactly the percentage; the convoy's nose sits at its end, so at low percentages the trucks are
  // still driving in from the left edge
  const fillTo = (Math.max(0, Math.min(100, percent)) / 100) * (VIEW_W - 2)
  const x = fillTo - CONVOY_W - 2
  return (
    <svg viewBox={`0 0 ${VIEW_W} 150`} className="block h-auto w-full overflow-hidden" aria-hidden="true" focusable="false">
      <style>{`
        .bb-spin { animation: bb-spin 0.6s linear infinite; }
        .bb-drum { animation: bb-spin 3.2s linear infinite; transform-box: fill-box; transform-origin: center; }
        .bb-lane { animation: bb-lane 0.5s linear infinite; }
        .bb-puff { animation: bb-puff 0.9s ease-out infinite; transform-box: fill-box; transform-origin: center; }
        .bb-bounce { animation: bb-bounce 0.6s ease-in-out 3; }
        .bb-pop { animation: bb-pop 0.35s ease-out both; transform-box: fill-box; transform-origin: center; }
        @keyframes bb-spin { to { transform: rotate(360deg); } }
        @keyframes bb-lane { to { stroke-dashoffset: 20; } }
        @keyframes bb-puff { 0% { opacity: 0.7; transform: translate(0, 0) scale(0.5); } 100% { opacity: 0; transform: translate(-16px, -8px) scale(1.4); } }
        @keyframes bb-bounce { 0%, 100% { transform: translateY(0); } 40% { transform: translateY(-8px); } }
        @keyframes bb-pop { from { opacity: 0; transform: scale(0.3); } to { opacity: 1; transform: scale(1); } }
        @media (prefers-reduced-motion: reduce) {
          .bb-spin, .bb-drum, .bb-lane, .bb-puff, .bb-bounce, .bb-pop { animation: none !important; }
        }
      `}</style>
      <defs>
        <clipPath id="bb-drum-clip">
          <path d="M6 104 Q4 70 24 56 Q40 46 58 52 Q72 58 72 80 L72 104 Z" />
        </clipPath>
      </defs>

      {/* road = progress bar */}
      <rect x={0} y={128} width={VIEW_W} height={20} rx={6} className="fill-slate-200 stroke-slate-900" strokeWidth={1.5} />
      <rect x={1} y={129} width={Math.max(0, Math.min(VIEW_W - 2, fillTo))} height={18} rx={5} className="fill-brand-500" style={{ transition: 'width 200ms linear' }} />
      <line x1={4} y1={138} x2={VIEW_W - 4} y2={138} className={clsx('stroke-slate-50', moving && 'bb-lane')} strokeWidth={2.5} strokeDasharray="10 10" strokeLinecap="round" />

      <g style={{ transform: `translateX(${x}px)`, transition: 'transform 200ms linear' }}>
        {/* dust behind the mixer's rear wheels */}
        {moving && [0, 0.3, 0.6].map((delay) => (
          <circle key={delay} cx={6} cy={122} r={4} className="bb-puff fill-slate-400" style={{ animationDelay: `${delay}s` }} />
        ))}

        {/* concrete mixer, following */}
        <g className={finished ? 'bb-bounce' : undefined}>
          <rect x={2} y={106} width={92} height={7} rx={2} className="fill-slate-700 stroke-slate-900" strokeWidth={1.5} />
          <path d="M-8 98 L8 94 L8 104 Z" className="fill-slate-300 stroke-slate-900" strokeWidth={1.5} strokeLinejoin="round" />
          <g clipPath="url(#bb-drum-clip)">
            <rect x={0} y={44} width={80} height={64} className="fill-brand-600" />
            <g className={moving ? 'bb-drum' : undefined}>
              {STRIPES.map((o) => (
                <line key={o} x1={o} y1={116} x2={o + 56} y2={36} className="stroke-amber-500" strokeWidth={7} opacity={0.85} />
              ))}
            </g>
          </g>
          <path d="M6 104 Q4 70 24 56 Q40 46 58 52 Q72 58 72 80 L72 104 Z" className="fill-none stroke-slate-900" strokeWidth={1.5} strokeLinejoin="round" />
          {/* face */}
          <ellipse cx={26} cy={85} rx={4.5} ry={3} className="fill-rose-400" opacity={0.7} />
          <ellipse cx={54} cy={85} rx={4.5} ry={3} className="fill-rose-400" opacity={0.7} />
          <circle cx={31} cy={77} r={3} className="fill-ink" />
          <circle cx={49} cy={77} r={3} className="fill-ink" />
          <circle cx={32} cy={76} r={0.9} className="fill-white" />
          <circle cx={50} cy={76} r={0.9} className="fill-white" />
          <path d="M34 85 Q40 91 46 85" className="fill-none stroke-ink" strokeWidth={1.8} strokeLinecap="round" />
          {/* cab */}
          <path d="M74 106 V76 Q74 70 80 70 H86 L96 86 V106 Z" className="fill-emerald-500 stroke-slate-900" strokeWidth={1.5} strokeLinejoin="round" />
          <path d="M79 76 H85 L91 86 H79 Z" className="fill-slate-100 stroke-slate-900" strokeWidth={1.2} strokeLinejoin="round" />
          <Wheel cx={14} spin={moving} />
          <Wheel cx={32} spin={moving} />
          <Wheel cx={84} spin={moving} />
          {finished && (
            <g className="bb-pop">
              <circle cx={40} cy={26} r={11} className="fill-emerald-500 stroke-slate-900" strokeWidth={1.5} />
              <path d="M34 26.5 L38.5 31 L46 21.5" className="fill-none stroke-white" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
            </g>
          )}
        </g>

        {/* semi truck carrying the PDF, in front */}
        <g>
          <rect x={110} y={108} width={128} height={6} rx={2} className="fill-slate-700 stroke-slate-900" strokeWidth={1.5} />
          <rect x={110} y={40} width={94} height={68} rx={5} className="fill-slate-100 stroke-slate-900" strokeWidth={1.5} />
          <path d="M138 50 H168 L182 64 V100 H138 Z" className="fill-white stroke-slate-900" strokeWidth={1.5} strokeLinejoin="round" />
          <path d="M168 50 V64 H182" className="fill-slate-200 stroke-slate-900" strokeWidth={1.5} strokeLinejoin="round" />
          <text x={158} y={87} textAnchor="middle" fontSize={15} fontWeight={800} className="fill-rose-600" fontFamily="inherit">PDF</text>
          <line x1={146} y1={94} x2={174} y2={94} className="stroke-slate-300" strokeWidth={2} strokeLinecap="round" />
          <path d="M206 108 V74 Q206 66 214 66 H228 L238 84 V108 Z" className="fill-orange-500 stroke-slate-900" strokeWidth={1.5} strokeLinejoin="round" />
          <path d="M213 73 H226 L232 84 H213 Z" className="fill-slate-100 stroke-slate-900" strokeWidth={1.2} strokeLinejoin="round" />
          <Wheel cx={126} spin={moving} />
          <Wheel cx={146} spin={moving} />
          <Wheel cx={222} spin={moving} />
        </g>
      </g>
    </svg>
  )
}

/* ---- card ---- */

interface View {
  files: ImportFileProgress[]
}

function LoaderCard({ files, onHide, onCancel, cancelling }: View & { onHide: () => void; onCancel?: () => void; cancelling?: boolean }) {
  const percent = overallPercent(files)
  const current = files.findIndex((f) => f.phase !== 'done' && f.phase !== 'failed')
  const shown = files[current >= 0 ? current : files.length - 1]
  const phase: ImportPhase = shown?.phase ?? 'queued'
  const finished = files.length > 0 && files.every((f) => f.phase === 'done' || f.phase === 'failed') && files.some((f) => f.phase === 'done')
  const failed = files.length > 0 && files.every((f) => f.phase === 'failed')
  const phaseText = finished ? PHASE_TEXT.done : PHASE_TEXT[phase]
  // screen readers hear the phase and every 10 %, not every tick
  const spoken = `Importing: ${pct(Math.floor(percent / 10) * 10)}, ${phaseText}`
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-ink/50 p-4">
      <div className="relative w-full max-w-[420px] rounded-3xl border border-slate-200 bg-white p-5 shadow-xl">
        <div role="status" aria-live="polite" className="sr-only">{spoken}</div>
        <button
          type="button"
          onClick={onHide}
          className="absolute top-3 right-3 rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-600"
        >
          Hide
        </button>
        <div className="pt-4">
          <Illustration percent={percent} finished={finished} failed={failed} />
        </div>
        <div className="mt-3 text-center">
          <div className="num display text-4xl text-slate-900">{pct(percent)}</div>
          <p className="mt-1 text-sm font-semibold text-slate-900">{phaseText}</p>
          {shown && <p className="mt-0.5 truncate text-sm text-slate-600" title={shown.name}>{shown.name}</p>}
          {files.length > 1 && <p className="text-xs text-slate-500">File {Math.min(files.length, (current >= 0 ? current : files.length - 1) + 1)} of {files.length}</p>}
          {phase === 'reading' && !finished && (
            <p className="mt-2 text-xs text-slate-500">The server reads the PDF; the percentage is an estimate.</p>
          )}
          {onCancel && !finished && (
            <button
              type="button"
              onClick={onCancel}
              disabled={cancelling}
              className="mt-4 inline-flex h-9 items-center rounded-md bg-slate-100 px-4 text-sm font-semibold text-slate-900 hover:bg-slate-200 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-600"
            >
              {cancelling ? 'Cancelling…' : 'Cancel import'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function LoaderPill({ files, onShow }: View & { onShow: () => void }) {
  return (
    <button
      type="button"
      onClick={onShow}
      aria-label={`Importing, ${pct(overallPercent(files))}. Show details`}
      className="num fixed bottom-4 left-4 z-[95] rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-900 shadow-lg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-600"
    >
      {pct(overallPercent(files))}
    </button>
  )
}

/**
 * QA hook: `?loader=demo` plays a fake import (0 → 100 % over 12 s through every phase, then a short pause and again)
 * so the loader can be reviewed and screenshotted without importing anything.
 */
const DEMO_MS = 12_000
const DEMO_PAUSE_MS = 2_500

function useDemoFiles(enabled: boolean): ImportFileProgress[] | null {
  const [t, setT] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const start = Date.now()
    const id = setInterval(() => setT((Date.now() - start) % (DEMO_MS + DEMO_PAUSE_MS)), 100)
    return () => clearInterval(id)
  }, [enabled])
  if (!enabled) return null
  const p = Math.min(100, (t / DEMO_MS) * 100)
  const phase: ImportPhase = p >= 100 ? 'done' : p >= 95 ? 'building' : 'reading'
  return [{ name: 'LV_11_Stahlbetonfertigteile_Sandwichsockel.pdf', size: 2_400_000, phase, pct: p }]
}

export function ImportLoader() {
  const active = useImportProgress((s) => s.active)
  const real = useImportProgress((s) => s.files)
  const cancel = useImportProgress((s) => s.cancel)
  const cancelled = useImportProgress((s) => s.cancelled)
  const demo = useDemoFiles(typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('loader') === 'demo')
  const [delayed, setDelayed] = useState(false)
  const [hidden, setHidden] = useState(false)

  // don't flash the loader for a quick import (X83, CSV)
  useEffect(() => {
    if (!active) {
      setDelayed(false)
      setHidden(false)
      return
    }
    const id = setTimeout(() => setDelayed(true), SHOW_AFTER_MS)
    return () => clearTimeout(id)
  }, [active])

  const files = demo ?? real
  if (!demo && !(active && delayed)) return null
  if (!files.length) return null
  return createPortal(
    hidden ? <LoaderPill files={files} onShow={() => setHidden(false)} />
      : <LoaderCard files={files} onHide={() => setHidden(true)} onCancel={demo ? undefined : cancel} cancelling={cancelled} />,
    document.body,
  )
}
