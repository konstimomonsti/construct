import type { CategoryNode, Position } from './types'
import type { TableOpts } from './export/table'
import type { Cat } from './export/util'

export const PDF_LIST_ATTACHMENT = 'billbuild-list.json'
export const DOCX_LIST_PART = 'customXml/billbuild-list.xml'
export const DOCX_LIST_NAMESPACE = 'urn:billbuild:list'

export function exportPosition(position: Position, longTexts: boolean, prices: boolean): Position {
  const result = { ...position, long: longTexts ? position.long : undefined }
  if (!prices) {
    result.up = null
    // Synced positions created by older clients may still carry written source prices.
    delete (result as Position & { sourceFacts?: unknown }).sourceFacts
  }
  return result
}

/** Structured positions in document exports preserve what was selected for export. */
export function documentList({ doc, positions, tree, longTexts, prices }: TableOpts): string {
  const category = (c: Cat): CategoryNode => ({ oz: c.oz, label: c.label, depth: c.depth, gaebSectionScope: c.gaebSectionScope, children: c.cats.map(category) })
  return JSON.stringify({
    title: doc.title,
    currency: doc.currency,
    positions: positions.map((p) => ({
      ...exportPosition(p, longTexts, prices),
      srcRef: undefined,
    })),
    tree: tree.roots.map(category),
  })
}
