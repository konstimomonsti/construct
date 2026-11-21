import type { CategoryNode } from './types'
import type { TableOpts } from './export/table'
import type { Cat } from './export/util'

export const PDF_LIST_ATTACHMENT = 'billbuild-list.json'
export const DOCX_LIST_PART = 'customXml/billbuild-list.xml'
export const DOCX_LIST_NAMESPACE = 'urn:billbuild:list'

/** Structured positions in document exports preserve what was selected for export. */
export function documentList({ doc, positions, tree, longTexts, prices }: TableOpts): string {
  const category = (c: Cat): CategoryNode => ({ oz: c.oz, label: c.label, depth: c.depth, children: c.cats.map(category) })
  return JSON.stringify({
    title: doc.title,
    currency: doc.currency,
    positions: positions.map((p) => ({
      ...p,
      long: longTexts ? p.long : undefined,
      up: prices ? p.up : null,
      srcRef: undefined,
    })),
    tree: tree.roots.map(category),
  })
}
