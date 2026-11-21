import { useId } from 'react'
import { clsx } from 'clsx'
import { Icon } from './ui'
import type { SubcontractPackage } from '../lib/subcontract'

export type TimelineStage = 'x83' | 'x84' | 'x86'

export interface CraneTimelineProps {
  stage: TimelineStage
  dates: {
    received?: string
    sent?: string
    confirmed?: string
  }
  lastUpdate?: string
  positionsCount: number
  pricedCount: number
  subcontractPackages?: SubcontractPackage[]
  onOpenSubcontract?: () => void
  hasX86?: boolean
  onUploadX86?: () => void
  className?: string
}

export function CraneTimeline({
  stage,
  dates,
  lastUpdate,
  positionsCount,
  pricedCount,
  subcontractPackages = [],
  onOpenSubcontract,
  hasX86 = false,
  onUploadX86,
  className,
}: CraneTimelineProps) {
  const id = useId().replace(/:/g, '')

  // Discrete milestones:
  // x83 -> 1/3 (33.33%)
  // x84 -> 2/3 (66.67%)
  // x86 -> 3/3 (100.0%)
  const fillPct = stage === 'x86' ? 100 : stage === 'x84' ? 66.67 : 33.33
  const hookAt = fillPct

  // Person B Subcontractor events summary
  const sentPackages = subcontractPackages.filter((p) => p.status === 'sent' || p.sentAt)
  const offersReceived = subcontractPackages.filter((p) => p.status === 'offer_received')
  const totalPackages = subcontractPackages.length

  const jib = (key: string) => (
    <>
      <pattern id={`${id}-${key}`} width="16" height="18" patternUnits="userSpaceOnUse">
        <path d="M0 17 L8 1 L16 17" fill="none" stroke="currentColor" strokeWidth="1.25" />
      </pattern>
      <line x1="0" y1="1" x2="100%" y2="1" strokeWidth="2" />
      <line x1="0" y1="17" x2="100%" y2="17" strokeWidth="2" />
      <rect x="0" y="0" width="100%" height="18" fill={`url(#${id}-${key})`} stroke="none" />
    </>
  )

  return (
    <div className={clsx('relative w-full select-none', className)}>
      {/* Top: Actual expanded status and last update date */}
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold tracking-wider text-slate-500 uppercase">Procurement Lifecycle</span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-950">
            <span className="size-1.5 rounded-full bg-amber-600 animate-pulse" />
            {stage === 'x83' && 'Proposal received by the client'}
            {stage === 'x84' && 'Budget sent'}
            {stage === 'x86' && 'Contract awaiting for a signature!'}
          </span>
        </div>
        {lastUpdate && (
          <span className="text-xs text-slate-500">
            Last status update: <span className="font-medium text-slate-700">{lastUpdate}</span>
          </span>
        )}
      </div>

      {/* The Crane Jib Boom SVG */}
      <div className="relative pb-6" role="progressbar" aria-label="Tender flow progress" aria-valuenow={Math.round(fillPct)} aria-valuemin={0} aria-valuemax={100}>
        <svg width="100%" height="18" className="block overflow-visible" aria-hidden>
          <defs>
            <clipPath id={`${id}-clip`}>
              <rect x="0" y="-2" height="22" className="transition-[width] duration-700 ease-out" style={{ width: `${fillPct}%` }} />
            </clipPath>
          </defs>
          {/* Base dashed unlit truss (rest of jib) */}
          <g className="text-slate-300" stroke="currentColor" strokeDasharray="4 3">
            {jib('rest')}
          </g>
          {/* Lit yellow truss (active progress) */}
          <g className="text-jib" stroke="currentColor" clipPath={`url(#${id}-clip)`}>
            {jib('lit')}
          </g>
          {/* Structural Mast Vertical Dividers at 0%, 33.33%, 66.67%, 100% */}
          <rect x="0" y="-5" width="3" height="28" className="fill-slate-800" />
          <rect x="33.33%" y="-5" width="3" height="28" className="fill-slate-700" transform="translate(-1.5 0)" />
          <rect x="66.67%" y="-5" width="3" height="28" className="fill-slate-700" transform="translate(-1.5 0)" />
          <rect x="100%" y="-5" width="3" height="28" className="fill-slate-800" transform="translate(-3 0)" />
        </svg>

        {/* Traveling Crane Hook */}
        <svg
          width="14"
          height="18"
          viewBox="0 0 12 16"
          aria-hidden
          className="text-jib absolute top-[17px] -translate-x-1/2 transition-[left] duration-700 ease-out"
          style={{ left: `${hookAt}%` }}
        >
          <path d="M6 0 V8 M6 8 C6 8 2.5 8 2.5 11.5 C2.5 15 9.5 15 9.5 11.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>

        {/* Timeline Mast Labels & Milestone Dates at 0%, 1/3, 2/3 */}
        <div className="relative mt-2.5 flex justify-between text-[11px] font-medium text-slate-600 sm:text-xs">
          {/* 0% Marker: X83 */}
          <div className="w-1/3 pr-2 text-left">
            <div className="font-bold text-slate-900">RECEIVED (X83)</div>
            <div className="text-[11px] text-slate-500">{dates.received ? dates.received : 'Tender received'}</div>
          </div>

          {/* 33.33% Marker: X84 */}
          <div className="w-1/3 px-1 text-center">
            <div className="font-bold text-slate-900">ANSWERED (X84)</div>
            <div className="text-[11px] text-slate-500">{dates.sent ? dates.sent : stage === 'x83' ? 'Offer in preparation' : 'Offer sent'}</div>
          </div>

          {/* 66.67% Marker: X86 */}
          <div className="w-1/3 pl-2 text-right">
            <div className="font-bold text-slate-900">CONFIRMED (X86)</div>
            <div className="text-[11px] text-slate-500">{dates.confirmed ? dates.confirmed : hasX86 ? 'Award received' : 'Awaiting award'}</div>
          </div>
        </div>
      </div>

      {/* Sequence of stages below the crane jib:
          tender received → positions priced → quotes requested → offer generated → award received */}
      <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {/* Stage 1: Tender received */}
        <div className={clsx('flex flex-col rounded-md border p-2 text-xs transition-colors', stage === 'x83' ? 'border-amber-400 bg-amber-50/50' : 'border-slate-200 bg-slate-50/60')}>
          <div className="flex items-center gap-1 font-semibold text-slate-800">
            <Icon name="check_circle" size={14} className="text-emerald-700" />
            <span>Tender received</span>
          </div>
          <span className="mt-1 text-[11px] text-slate-500">{positionsCount} positions in LV</span>
        </div>

        {/* Stage 2: Positions priced */}
        <div className={clsx('flex flex-col rounded-md border p-2 text-xs transition-colors', pricedCount < positionsCount && stage === 'x83' ? 'border-amber-400 bg-amber-50/50' : 'border-slate-200 bg-slate-50/60')}>
          <div className="flex items-center justify-between font-semibold text-slate-800">
            <span>Positions priced</span>
            <span className="num font-bold text-slate-900">{Math.round((pricedCount / (positionsCount || 1)) * 100)}%</span>
          </div>
          <span className="mt-1 text-[11px] text-slate-500">
            {pricedCount} of {positionsCount} priced
            {positionsCount - pricedCount > 0 && <span className="text-amber-800"> ({positionsCount - pricedCount} open)</span>}
          </span>
        </div>

        {/* Stage 3: Quotes requested (Person B Subcontractor events) */}
        <div
          onClick={onOpenSubcontract}
          role={onOpenSubcontract ? 'button' : undefined}
          tabIndex={onOpenSubcontract ? 0 : undefined}
          className={clsx(
            'flex flex-col rounded-md border p-2 text-xs transition-colors text-left',
            totalPackages > 0 ? 'border-sky-300 bg-sky-50/40 hover:bg-sky-50' : 'border-slate-200 bg-slate-50/60',
            onOpenSubcontract && 'cursor-pointer',
          )}
        >
          <div className="flex items-center justify-between font-semibold text-slate-800">
            <span className="flex items-center gap-1">
              <Icon name="mail" size={14} className="text-sky-700" />
              <span>Quotes requested</span>
            </span>
            {totalPackages > 0 && <span className="num rounded bg-sky-100 px-1 text-[10px] text-sky-800">{totalPackages}</span>}
          </div>
          <span className="mt-1 text-[11px] text-slate-500">
            {totalPackages === 0
              ? 'No packages yet'
              : `${sentPackages.length} sent, ${offersReceived.length} received`}
          </span>
        </div>

        {/* Stage 4: Offer generated */}
        <div className={clsx('flex flex-col rounded-md border p-2 text-xs transition-colors', stage === 'x84' ? 'border-amber-400 bg-amber-50/50' : 'border-slate-200 bg-slate-50/60')}>
          <div className="flex items-center gap-1 font-semibold text-slate-800">
            <Icon name={stage === 'x84' || stage === 'x86' ? 'task_alt' : 'schedule'} size={14} className={stage === 'x84' || stage === 'x86' ? 'text-emerald-700' : 'text-slate-400'} />
            <span>Offer generated</span>
          </div>
          <span className="mt-1 text-[11px] text-slate-500">
            {stage === 'x83' ? 'Draft in progress' : 'X84 ready / sent'}
          </span>
        </div>

        {/* Stage 5: Award received */}
        <div className={clsx('flex flex-col rounded-md border p-2 text-xs transition-colors', stage === 'x86' ? 'border-emerald-500 bg-emerald-50/50' : 'border-slate-200 bg-slate-50/60')}>
          <div className="flex items-center justify-between font-semibold text-slate-800">
            <span className="flex items-center gap-1">
              <Icon name={hasX86 ? 'verified' : 'hourglass_empty'} size={14} className={hasX86 ? 'text-emerald-700' : 'text-slate-400'} />
              <span>Award received</span>
            </span>
            {!hasX86 && onUploadX86 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onUploadX86()
                }}
                className="text-[10px] font-semibold text-blue-700 underline hover:text-blue-900"
              >
                + Upload
              </button>
            )}
          </div>
          <span className="mt-1 text-[11px] text-slate-500">
            {hasX86 ? 'X86 contract matched' : 'Awaiting client decision'}
          </span>
        </div>
      </div>
    </div>
  )
}
