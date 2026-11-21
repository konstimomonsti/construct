import type { CategoryNode, ListDoc, Position } from '../types'

export type FormatId = 'csv' | 'xlsx' | 'pdf' | 'x83' | 'x83-2004' | 'x84' | 'd83' | 'd84' | 'd86' | 'docx' | 'json'

export type Scope = 'all' | 'selection' | 'categories'

/** per-OZ styled long-text lines extracted from the source PDF (scripts/pdf-layout.py) */
export interface LayoutLine {
  t: string
  b?: 1
  i?: 1
  /** part of the (bold) short text */
  s?: 1
  /** indentation relative to the text column, in pt */
  x?: number
  /** baseline gap to the previous line in pt (omitted = regular pitch) */
  g?: number
  /** column segments of a line with value columns */
  segs?: { t: string; x: number }[]
}
export interface LayoutEntry {
  lines: LayoutLine[]
  /** 'c' = category heading block */
  k?: 'c'
  /** original OZ token as printed (e.g. ".2") */
  tok?: string
  /** gap from the qty row to the next OZ line */
  qg?: number
  /** gap from the last line to the next OZ line */
  eg?: number
  ok?: number
}
export interface FurnitureItem {
  x: number
  y: number
  t: string
  f: string
  s: number
  b?: 1
  i?: 1
  c?: string
  /** 'page' items repeat on every page; 'first' only on page 1 */
  w?: 'page' | 'first'
}
export interface PdfFurniture {
  /** text items repeated on every page (letterhead, project block, footers), from the original */
  items?: FurnitureItem[]
  size?: [number, number]
}
export interface LayoutFile {
  furniture?: PdfFurniture
  positions: Record<string, LayoutEntry>
}

export interface ExportRequest {
  doc: ListDoc
  /** the list as the user sees it (resolveList output) */
  resolved: { positions: Position[]; tree: CategoryNode[] }
  format: FormatId
  scope?: Scope
  selectedIds?: string[]
  /** category OZs whose positions and descendants are included when scope === 'categories' */
  categoryOzs?: string[]
  longTexts?: boolean
  prices?: boolean
  /** returns the bytes of the original source file (or null when there is none) */
  loadOriginal?: () => Promise<Uint8Array | null>
  /** returns the styled-line layout json of a PDF-sourced list (when present) */
  loadLayout?: () => Promise<LayoutFile | null>
  /** true when the user changed the list (qty/price/removed/added/moved…) */
  edited?: boolean
  now?: Date
}

export type ExportMode = 'original' | 'patched' | 'generated'

export interface ExportResult {
  data: Uint8Array
  fileName: string
  mime: string
  mode: ExportMode
}

export interface FormatInfo {
  id: FormatId
  label: string
  ext: string
  mime: string
  icon: string
  desc: string
  /** tender (Leistungsverzeichnis) formats carry no prices per GAEB rules */
  tender?: boolean
  /** prices are always written */
  priced?: boolean
}
