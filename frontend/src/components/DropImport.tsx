import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Icon } from './ui'
import { importFiles, type ImportResult } from '../lib/import'

/** window-level drag & drop import into a folder; returns whether a file drag is active */
export function useDropImport(folderId: string, enabled = true, onDone?: (result: ImportResult) => void): boolean {
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let depth = 0
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setDragging(true)
    }
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length) void importFiles(files, folderId).then(onDone)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [folderId, enabled, onDone])
  return dragging
}

export function DropOverlay({ show, name }: { show: boolean; name: string }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          aria-hidden
          className="pointer-events-none fixed inset-3 z-[60] flex items-center justify-center rounded-lg border-2 border-dashed border-brand-500 bg-brand-50/90"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <div className="flex flex-col items-center gap-2 text-brand-700">
            <Icon name="cloud_upload" size={40} />
            <p className="font-heading text-base font-bold">Drop files to import into "{name}"</p>
            <p className="text-[13px] text-brand-700">Tender files (GAEB, PDF, Word) or price sheets (Excel, CSV, TSV, JSON)</p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
