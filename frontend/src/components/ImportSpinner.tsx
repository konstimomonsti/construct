import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useImportActivity } from '../lib/import-activity'

const SHOW_AFTER_MS = 400
const FADE_MS = 180
const DEMO_NAMES = ['LV_11_Stahlbetonfertigteile_Sandwichsockel.pdf']

const css = `
.bb-imp-card { animation: bb-imp-in ${FADE_MS}ms ease-out; transition: opacity ${FADE_MS}ms ease-out; }
.bb-imp-bob { animation: bb-imp-bob 0.6s ease-in-out infinite alternate; }
.bb-imp-road { animation: bb-imp-road 0.5s linear infinite; }
.bb-imp-spin { transform-box: fill-box; transform-origin: center; animation: bb-imp-spin 1.6s linear infinite; }
.bb-imp-wheel { transform-box: fill-box; transform-origin: center; animation: bb-imp-spin 0.45s linear infinite; }
@keyframes bb-imp-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes bb-imp-bob { from { transform: translateY(0); } to { transform: translateY(-0.9px); } }
@keyframes bb-imp-road { from { stroke-dashoffset: 0; } to { stroke-dashoffset: 8; } }
@keyframes bb-imp-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .bb-imp-card, .bb-imp-bob, .bb-imp-road, .bb-imp-spin, .bb-imp-wheel { animation: none; }
}
`

const line = 'var(--color-slate-900)'
const stripes = [-3, -2, -1, 0, 1, 2, 3]

function Truck() {
  return (
    <svg width="64" height="32" viewBox="0 0 64 32" aria-hidden="true" focusable="false" className="shrink-0">
      <style>{css}</style>
      <defs>
        <clipPath id="bb-imp-drum">
          <rect x="7" y="5" width="31" height="17" rx="8.5" />
        </clipPath>
      </defs>
      <line className="bb-imp-road" x1="0" x2="64" y1="29.5" y2="29.5" stroke="var(--color-slate-400)" strokeWidth="1.25" strokeDasharray="4 4" strokeLinecap="round" />
      <g className="bb-imp-bob" strokeLinejoin="round" strokeLinecap="round">
        {/* chassis */}
        <rect x="5" y="21" width="51" height="3.5" rx="1.75" fill="var(--color-slate-300)" stroke={line} strokeWidth="1.25" />
        {/* cab */}
        <path d="M40 24 V13 Q40 10.5 42.5 10.5 H49 Q51 10.5 52.2 12.4 L55.5 17.5 Q56.2 18.6 56.2 20 V24 Z" fill="var(--color-emerald-500)" stroke={line} strokeWidth="1.25" />
        <path d="M43 13 H48.4 L51.6 17.6 H43 Z" fill="var(--color-emerald-100)" stroke={line} strokeWidth="1" />
        {/* drum with rotating stripes */}
        <g clipPath="url(#bb-imp-drum)">
          <rect x="7" y="5" width="31" height="17" fill="var(--color-brand-500)" />
          <g className="bb-imp-spin">
            {stripes.map((i) => (
              <line key={i} x1={22.5 + i * 7 - 12} y1="-8" x2={22.5 + i * 7 + 12} y2="35" stroke="var(--color-brand-100)" strokeWidth="2.4" />
            ))}
          </g>
        </g>
        <rect x="7" y="5" width="31" height="17" rx="8.5" fill="none" stroke={line} strokeWidth="1.25" />
        {/* face */}
        <circle cx="18.5" cy="12" r="1.3" fill="var(--color-ink)" />
        <circle cx="26.5" cy="12" r="1.3" fill="var(--color-ink)" />
        <path d="M20.3 15.2 Q22.5 17.6 24.7 15.2" fill="none" stroke="var(--color-ink)" strokeWidth="1" />
        <ellipse cx="15.6" cy="14.9" rx="1.7" ry="1" fill="var(--color-rose-400)" opacity="0.85" />
        <ellipse cx="29.4" cy="14.9" rx="1.7" ry="1" fill="var(--color-rose-400)" opacity="0.85" />
        {/* wheels */}
        {[15, 46].map((x) => (
          <g key={x}>
            <circle cx={x} cy="25" r="4" fill="var(--color-ink)" stroke={line} strokeWidth="1.25" />
            <g className="bb-imp-wheel">
              <circle cx={x} cy="25" r="1.6" fill="var(--color-slate-300)" />
              <line x1={x - 1.6} y1="25" x2={x + 1.6} y2="25" stroke="var(--color-ink)" strokeWidth="0.8" />
            </g>
          </g>
        ))}
      </g>
    </svg>
  )
}

function useDemoFlag() {
  const [demo] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('importing') === 'demo'
    } catch {
      return false
    }
  })
  return demo
}

/**
 * Mini, non-blocking "import running" indicator. Purely informational: it only reads the import-activity store
 * and never delays or awaits anything. Shows up if an import is still running after 400 ms.
 */
export function ImportSpinner() {
  const demo = useDemoFlag()
  const importing = useImportActivity((s) => s.importing)
  const names = demo ? DEMO_NAMES : importing
  const active = names.length > 0
  const [shown, setShown] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [last, setLast] = useState<string[]>([])

  useEffect(() => {
    if (!active) return
    setLast(names)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, names.join('\n')])

  useEffect(() => {
    if (active) {
      const t = window.setTimeout(() => {
        setMounted(true)
        setShown(true)
      }, SHOW_AFTER_MS)
      return () => window.clearTimeout(t)
    }
    setShown(false)
    const t = window.setTimeout(() => setMounted(false), FADE_MS)
    return () => window.clearTimeout(t)
  }, [active])

  if (!mounted || typeof document === 'undefined') return null
  const shownNames = names.length ? names : last
  const first = shownNames[0] ?? ''
  const many = shownNames.length > 1
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 left-4 z-40 max-w-[calc(100vw-2rem)] lg:left-[calc(var(--side,240px)+1rem)]"
    >
      <div
        className="bb-imp-card flex items-center gap-2.5 rounded-2xl border border-slate-200 bg-white py-1.5 pr-4 pl-2 shadow-lg"
        style={{ opacity: shown ? 1 : 0 }}
        title={shownNames.join(', ')}
      >
        <span className="sr-only">{`Importing ${many ? `${shownNames.length} files` : first}`}</span>
        <Truck />
        <div className="flex min-w-0 flex-col" aria-hidden="true">
          <span className="text-xs font-semibold text-slate-800">{many ? `Importing ${shownNames.length} files …` : 'Importing …'}</span>
          <span className="max-w-[12rem] truncate text-xs text-slate-500" title={many ? shownNames.join(', ') : first}>{first}</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
