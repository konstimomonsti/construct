export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** line total with commercial cent rounding to match backend and GAEB standards */
export const positionTotal = (p: { qty: number; up: number | null }) => round2((p.up ?? 0) * p.qty)
