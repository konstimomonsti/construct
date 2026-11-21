import { useCallback, useEffect, useState } from 'react'
import { scanCatalogue, type CatalogueEntry } from '../../lib/catalogues'

type Result = { attempt: number; rows: CatalogueEntry[]; done: boolean; error: string }

/** the subcontractor catalogue (active entries), read the way the catalogue page reads it */
export function useSubcontractors(enabled: boolean) {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<Result>({ attempt: -1, rows: [], done: false, error: '' })

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    const at = attempt
    scanCatalogue('subcontractors', { q: '', supplier: null, archived: false }, controller.signal, (rows) => setResult({ attempt: at, rows, done: false, error: '' }))
      .then((r) => setResult({ attempt: at, rows: r.rows, done: true, error: '' }))
      .catch((e: Error) => {
        if (!controller.signal.aborted) setResult({ attempt: at, rows: [], done: true, error: e.message || 'The subcontractor catalogue could not be loaded.' })
      })
    return () => controller.abort()
  }, [enabled, attempt])

  const fresh = result.attempt === attempt
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { rows: result.rows, loading: enabled && !(fresh && result.done), error: fresh ? result.error : '', retry }
}
