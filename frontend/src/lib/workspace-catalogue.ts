import { useEffect, useState } from 'react'

type Product = { id: string; name: string; category: string }
type Suggestion = { name: string; description: string; url: string; source: string }

export type CataloguePosition = {
  model_review?: boolean
  state: 'matched' | 'activity' | 'needs_description' | 'queued' | 'researching' | 'suggested' | 'no_evidence' | 'failed' | 'research_disabled'
  recovered: { short: string; long: string; source: string | null } | null
  product: Product | null
  suggestion: Suggestion | null
}

export type CatalogueReport = {
  state: 'queued' | 'ready' | 'failed' | 'unstarted'
  positions: Record<string, CataloguePosition>
  web_research?: boolean
}

const endpoint = (id: string) => `/api/workspace/catalogue?id=${encodeURIComponent(id)}`

async function readReport(response: Response): Promise<CatalogueReport> {
  const report = await response.json() as Partial<CatalogueReport> | null
  if (!report?.positions || typeof report.positions !== 'object' || Array.isArray(report.positions) || !report.state) {
    throw new Error('Unexpected catalogue response.')
  }
  return { state: report.state, positions: report.positions, web_research: report.web_research }
}

export function useWorkspaceCatalogue(id: string | null, documentIds: string) {
  const [report, setReport] = useState<CatalogueReport | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!id) return
    let timer: ReturnType<typeof setTimeout>
    const controller = new AbortController()
    async function refresh() {
      try {
        const response = await fetch(endpoint(id!), { signal: controller.signal, cache: 'no-store' })
        if (response.status === 404) {
          timer = setTimeout(refresh, 1800)
          return
        }
        if (!response.ok) throw new Error('Catalogue results are temporarily unavailable.')
        let result = await readReport(response)
        if (result.state === 'unstarted') {
          const start = await fetch(endpoint(id!), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal,
          })
          if (!start.ok) throw new Error('Catalogue matching could not start.')
          result = await readReport(start)
        }
        if (controller.signal.aborted) return
        setReport(result)
        setError('')
        if (result.state === 'queued' || Object.values(result.positions).some((p) => p.state === 'queued' || p.state === 'researching')) {
          timer = setTimeout(refresh, 1800)
        }
      } catch {
        if (!controller.signal.aborted) setError('Catalogue results are temporarily unavailable.')
      }
    }
    void refresh()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [id, documentIds, retry])

  async function retryFailed() {
    if (!id) return
    try {
      const response = await fetch(endpoint(id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retry: true }),
      })
      if (!response.ok) throw new Error()
      setReport(await readReport(response))
      setError('')
      setRetry((n) => n + 1)
    } catch {
      setError('Catalogue research could not restart.')
    }
  }
  return { report, error, retryFailed }
}
