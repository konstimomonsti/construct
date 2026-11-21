/** line total (kept tiny so the full GAEB parser stays out of the main bundle) */
export const positionTotal = (p: { qty: number; up: number | null }) => (p.up ?? 0) * p.qty
