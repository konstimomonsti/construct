import { clsx } from 'clsx'
import { Icon } from './ui'

export type DocumentTab = 'x83' | 'x84' | 'x86'

export interface DocumentStageTabsProps {
  activeTab: DocumentTab
  onSelectTab: (tab: DocumentTab) => void
  hasX86: boolean
  onUploadX86?: () => void
  x84DiffCount?: number
  x86DiffCount?: number
  className?: string
}

export function DocumentStageTabs({
  activeTab,
  onSelectTab,
  hasX86,
  onUploadX86,
  x84DiffCount = 0,
  x86DiffCount = 0,
  className,
}: DocumentStageTabsProps) {
  return (
    <div className={clsx('flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3', className)}>
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Document lifecycle stages">
        {/* Tab 1: X83 Tender Received */}
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'x83'}
          onClick={() => onSelectTab('x83')}
          className={clsx(
            'inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-xs font-semibold tracking-tight transition-all',
            activeTab === 'x83'
              ? 'bg-amber-300 text-slate-950 shadow-sm ring-1 ring-amber-400/80 font-bold'
              : 'bg-slate-100 text-slate-800 hover:bg-slate-200',
          )}
        >
          <Icon name="description" size={16} />
          <span>X83 Received</span>
          <span className="text-[10px] font-normal opacity-80">(Original Tender)</span>
        </button>

        {/* Tab 2: X84 Offer Sent / Working */}
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'x84'}
          onClick={() => onSelectTab('x84')}
          className={clsx(
            'inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-xs font-semibold tracking-tight transition-all',
            activeTab === 'x84'
              ? 'bg-amber-300 text-slate-950 shadow-sm ring-1 ring-amber-400/80 font-bold'
              : 'bg-slate-100 text-slate-800 hover:bg-slate-200',
          )}
        >
          <Icon name="request_quote" size={16} />
          <span>X84 Answered</span>
          <span className="text-[10px] font-normal opacity-80">(Our Offer)</span>
          {x84DiffCount > 0 && (
            <span className={clsx('num ml-0.5 rounded-full px-1.5 py-0.2 text-[10px] font-bold', activeTab === 'x84' ? 'bg-amber-950 text-amber-200' : 'bg-slate-300 text-slate-800')}>
              {x84DiffCount} edits
            </span>
          )}
        </button>

        {/* Tab 3: X86 Award Confirmed */}
        {hasX86 ? (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'x86'}
            onClick={() => onSelectTab('x86')}
            className={clsx(
              'inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-xs font-semibold tracking-tight transition-all',
              activeTab === 'x86'
                ? 'bg-amber-300 text-slate-950 shadow-sm ring-1 ring-amber-400/80 font-bold'
                : 'bg-slate-100 text-slate-800 hover:bg-slate-200',
            )}
          >
            <Icon name="verified" size={16} />
            <span>X86 Confirmed</span>
            <span className="text-[10px] font-normal opacity-80">(Award)</span>
            {x86DiffCount > 0 && (
              <span className={clsx('num ml-0.5 rounded-full px-1.5 py-0.2 text-[10px] font-bold', activeTab === 'x86' ? 'bg-amber-950 text-amber-200' : 'bg-slate-300 text-slate-800')}>
                {x86DiffCount} deltas
              </span>
            )}
          </button>
        ) : (
          <button
            type="button"
            role="tab"
            aria-selected={false}
            onClick={onUploadX86}
            title="Upload client award document (X86/D86)"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-200 px-3.5 text-xs font-medium text-slate-600 transition-all hover:border-slate-400 hover:bg-slate-300/70"
          >
            <Icon name="upload_file" size={16} className="text-slate-500" />
            <span>X86 Confirmed</span>
            <span className="text-[10px] text-slate-500">(Not available yet · + Upload)</span>
          </button>
        )}
      </div>

      {/* Tab Context Info Banner */}
      <div className="flex items-center gap-2 text-xs text-slate-600">
        {activeTab === 'x83' && (
          <span className="flex items-center gap-1.5 rounded bg-slate-100 px-2 py-1 text-slate-700">
            <Icon name="lock" size={14} className="text-slate-500" />
            Read-only exact client tender baseline
          </span>
        )}
        {activeTab === 'x84' && (
          <span className="flex items-center gap-1.5 rounded bg-amber-50 px-2 py-1 text-amber-900 border border-amber-200">
            <Icon name="edit_note" size={14} className="text-amber-700" />
            Active offer with pricing suggestions & accepted fixes
          </span>
        )}
        {activeTab === 'x86' && hasX86 && (
          <span className="flex items-center gap-1.5 rounded bg-emerald-50 px-2 py-1 text-emerald-900 border border-emerald-200">
            <Icon name="verified" size={14} className="text-emerald-700" />
            Awarded contract with diff against our X84 offer
          </span>
        )}
      </div>
    </div>
  )
}
