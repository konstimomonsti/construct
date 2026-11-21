import { AnimatePresence, motion } from 'motion/react'
import { Icon, Menu, type MenuItem } from './ui'

export function Dock({
  open, count, noun, moveItems, onOpen, onDelete, onDone,
}: {
  open: boolean
  count: number
  noun: string
  moveItems: (MenuItem | 'sep')[]
  onOpen: () => void
  onDelete: () => void
  onDone: () => void
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          role="toolbar"
          aria-label="Batch actions"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16, transition: { duration: 0.15 } }}
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          className="fixed bottom-5 left-1/2 z-30 flex max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-3 py-2 shadow-lg backdrop-blur-md"
        >
          <div className="flex items-center gap-2 pr-1 pl-2">
            <span className="size-2 rounded-full bg-brand-600" />
            <span className="text-xs font-medium whitespace-nowrap text-slate-900" aria-live="polite">
              {count} {noun}{count === 1 ? '' : 's'} selected
            </span>
          </div>
          <div className="mx-1 h-4 w-px bg-slate-200" />
          <Menu
            label="Move selected"
            align="start"
            items={moveItems}
            trigger={(p) => (
              <button
                {...p}
                type="button"
                disabled={!count}
                className="flex h-7 items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-900 transition-colors hover:bg-slate-100 disabled:opacity-50"
              >
                <Icon name="drive_file_move" size={15} className="text-slate-500" />
                <span>Move</span>
              </button>
            )}
          />
          <button
            type="button"
            disabled={!count}
            onClick={onOpen}
            className="flex h-7 items-center gap-1.5 rounded-full bg-brand-600 px-3.5 text-xs font-semibold whitespace-nowrap text-white shadow-sm shadow-brand-600/20 transition-colors hover:bg-brand-700 disabled:opacity-50"
          >
            <Icon name="tab_group" size={15} />
            <span>Open Selected</span>
          </button>
          <button
            type="button"
            disabled={!count}
            onClick={onDelete}
            title="Move selected to Trash"
            aria-label="Move selected to Trash"
            className="flex size-7 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
          >
            <Icon name="delete" size={16} />
          </button>
          <div className="mx-1 h-4 w-px bg-slate-200" />
          <button
            type="button"
            onClick={onDone}
            className="h-7 rounded-full bg-slate-100 px-2.5 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-900"
          >
            Done
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
