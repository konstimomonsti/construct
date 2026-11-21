import { create } from 'zustand'

/** File names of the imports that are running right now (purely informational, drives the mini import indicator) */
export const useImportActivity = create<{ importing: string[] }>(() => ({ importing: [] }))

/** Register a running import. The returned function removes exactly the names this call added. */
export function startImport(names: string[]): () => void {
  const mine = [...names]
  useImportActivity.setState((s) => ({ importing: [...s.importing, ...mine] }))
  let finished = false
  return () => {
    if (finished) return
    finished = true
    useImportActivity.setState((s) => {
      const rest = [...s.importing]
      for (const name of mine) {
        const at = rest.indexOf(name)
        if (at >= 0) rest.splice(at, 1)
      }
      return { importing: rest }
    })
  }
}
