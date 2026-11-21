import type { Position } from './types'
import { positionTotal } from './money'

export function downloadText(name: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const esc = (s: string) => (/[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
const num = (n: number) => String(Math.round(n * 100) / 100).replace('.', ',')

export function toCsv(positions: Position[]): string {
  const head = 'OZ;Kurztext;Menge;Einheit;EP;GP;Kategorie'
  const rows = positions.map((p) =>
    [esc(p.oz), esc(p.short), String(p.qty).replace('.', ','), esc(p.unit), p.up == null ? '' : num(p.up), num(positionTotal(p)), esc(p.category)].join(';'),
  )
  return '﻿' + [head, ...rows].join('\r\n')
}

export const safeName = (s: string) => s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'liste'
