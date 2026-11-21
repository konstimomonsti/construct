/**
 * Is the backend there? Without it the proxy in front (Vite locally, Caddy on the VPS) answers 502/504 at once, but a
 * browser keeps sending a large request body before it reads that answer, so an upload to a missing backend hangs.
 * Ask /healthz first (3 s at most) and skip the upload when nobody is behind the proxy. Any other answer counts as
 * reachable (a 503 from a missing database still means the backend itself runs). The answer is reused for 5 s so a
 * multi-file import pings once.
 */
let cached: { at: number; ok: Promise<boolean> } | null = null

export function serverReachable(signal?: AbortSignal): Promise<boolean> {
  if (cached && Date.now() - cached.at < 5000) return cached.ok
  const timeout = AbortSignal.timeout(3000)
  const ok = fetch('/healthz', { cache: 'no-store', signal: signal ? AbortSignal.any([timeout, signal]) : timeout })
    .then((r) => r.status !== 502 && r.status !== 504)
    .catch(() => false)
  cached = { at: Date.now(), ok }
  return ok
}
