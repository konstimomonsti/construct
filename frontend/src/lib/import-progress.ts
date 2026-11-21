import { create } from 'zustand'

export type ImportPhase = 'queued' | 'uploading' | 'reading' | 'building' | 'done' | 'failed'

export interface ImportFileProgress {
  name: string
  size: number
  phase: ImportPhase
  pct: number
}

interface ImportProgressState {
  active: boolean
  files: ImportFileProgress[]
  begin: (files: { name: string; size: number }[]) => void
  update: (name: string, patch: Partial<Pick<ImportFileProgress, 'phase' | 'pct'>>) => void
  end: () => void
}

export const useImportProgress = create<ImportProgressState>((set) => ({
  active: false,
  files: [],
  begin: (files) => set({
    active: true,
    files: files.map((f) => ({ name: f.name, size: f.size, phase: 'queued' as const, pct: 0 })),
  }),
  update: (name, patch) => set((s) => {
    // same-named files are matched in order: the first one that is not finished takes the update
    const at = s.files.findIndex((f) => f.name === name && f.phase !== 'done' && f.phase !== 'failed')
    const i = at >= 0 ? at : s.files.findIndex((f) => f.name === name)
    if (i < 0) return s
    const files = s.files.slice()
    files[i] = { ...files[i], ...patch, pct: Math.max(0, Math.min(100, patch.pct ?? files[i].pct)) }
    return { files }
  }),
  end: () => set({ active: false, files: [] }),
}))

/** size-weighted mean of the per-file percentages (0..100) */
export function overallPercent(files: { size: number; pct: number }[]): number {
  if (!files.length) return 0
  let total = 0
  let sum = 0
  for (const f of files) {
    const w = Math.max(f.size, 1)
    total += w
    sum += w * Math.max(0, Math.min(100, f.pct))
  }
  return sum / total
}

const CEILING = 0.95
const RATE = 1.1

/**
 * Ease-out estimate of server work (0..0.95): ~63 % at `expectedMs`, ~89 % at 2.5x,
 * never above 95 % (the last 5 % only come when the server answers).
 */
export function estimatePct(elapsedMs: number, expectedMs: number): number {
  if (!(elapsedMs > 0) || !(expectedMs > 0)) return 0
  return Math.min(CEILING, CEILING * (1 - Math.exp(-RATE * (elapsedMs / expectedMs))))
}

const KEY = 'billbuild:import-ms-per-kb'
const DEFAULT_MS_PER_KB = 25
const MIN_EXPECTED_MS = 4000

function readMsPerKb(): number {
  try {
    const v = Number(localStorage.getItem(KEY))
    if (Number.isFinite(v) && v > 0) return v
  } catch { /* storage unavailable */ }
  return DEFAULT_MS_PER_KB
}

/** how long the server is expected to need for a file of this size, learned from earlier imports on this device */
export function expectedMs(sizeBytes: number): number {
  return Math.max(MIN_EXPECTED_MS, (sizeBytes / 1024) * readMsPerKb())
}

/** remember how long an import took (exponential moving average of ms per KB) */
export function recordDuration(sizeBytes: number, ms: number): void {
  const kb = sizeBytes / 1024
  if (!(kb > 0) || !(ms > 0) || !Number.isFinite(ms)) return
  const sample = Math.min(2000, Math.max(1, ms / kb))
  try {
    const old = Number(localStorage.getItem(KEY))
    const next = Number.isFinite(old) && old > 0 ? 0.6 * old + 0.4 * sample : sample
    localStorage.setItem(KEY, String(Math.round(next * 100) / 100))
  } catch { /* storage unavailable */ }
}
