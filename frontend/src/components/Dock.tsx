import { AnimatePresence, motion } from 'motion/react'
import { Icon, Menu, type MenuItem } from './ui'

export function Dock({
  open, count, noun, moveItems, onOpen, onDelete, onDone,
}: {
  open: boolean
  count: number
  noun: string
  moveItems?: (MenuItem | 'sep')[]
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
          className="fixed bottom-5 left-1/2 z-30 flex max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-2 rounded-full bg-slate-900 py-2 pr-2 pl-5 text-white shadow-xl"
        >
          <div className="flex items-center pr-2">
            <span className="text-sm font-semibold whitespace-nowrap" aria-live="polite">
              {count} {noun}{count === 1 ? '' : 's'} selected
            </span>
          </div>
          {moveItems?.length ? <Menu
            label="Move selected"
            align="start"
            items={moveItems}
            trigger={(p) => (
              <button
                {...p}
                type="button"
                disabled={!count}
                className="flex h-10 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors hover:bg-white/15 disabled:opacity-50"
              >
                <Icon name="drive_file_move" size={18} />
                <span>Move</span>
              </button>
            )}
          /> : null}
          <button
            type="button"
            disabled={!count}
            onClick={onOpen}
            className="flex h-10 items-center gap-1.5 rounded-full px-3 text-sm font-medium whitespace-nowrap transition-colors hover:bg-white/15 disabled:opacity-50"
          >
            <Icon name="tab_group" size={18} />
            <span>Open</span>
          </button>
          <button
            type="button"
            disabled={!count}
            onClick={onDelete}
            title="Move selected to Trash"
            aria-label="Move selected to Trash"
            className="flex h-10 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-rose-200 transition-colors hover:bg-white/15 disabled:opacity-50"
          >
            <Icon name="delete" size={18} />
            <span className="max-sm:sr-only">Trash</span>
          </button>
          <button
            type="button"
            onClick={onDone}
            className="h-10 rounded-full bg-white px-4 text-sm font-semibold text-slate-900 transition-colors hover:bg-slate-100"
          >
            Done
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
