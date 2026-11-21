import { treeFromPaths } from './cat'
import { indexTree, leafOz, naturalCompare } from './resolve'
import type { CategoryNode, CategoryRef, Position } from './types'

const ungrouped: CategoryRef = { oz: 'ungrouped', label: 'Without an OZ prefix' }
const normalizePrefix = (prefix: string) => prefix.replace(/(^|\.)0+(?=\d)/g, '$1')
const sectionCode = /^\d+(?:\.\d+)*$/

function prefixesOf(oz: string): string[] {
  const code = oz.trim().replace(/\.$/, '')
  if (!/^\d+(?:\.\d+)+[a-z]?$/i.test(code)) return []
  const parts = code.split('.')
  parts.pop()
  return parts.map((_, i) => parts.slice(0, i + 1).join('.'))
}

export const hasSectionLabel = (label: string | undefined) => !!label?.trim() && !/^(import|allgemein)$/i.test(label.trim())

/** A ledger view built from the current position numbers. Source paths remain available in the category view. */
export function groupByOz(positions: Position[]) {
  const rows = positions.map((position) => ({ position, prefixes: prefixesOf(position.oz) }))
  if (!rows.some(({ prefixes }) => prefixes.length)) return null

  const labels = new Map<string, string | null>()
  for (const { position, prefixes } of rows) {
    if (!prefixes.length) continue
    const keys = new Set(prefixes.map(normalizePrefix))
    for (const { oz, label } of position.path ?? []) {
      if (!sectionCode.test(oz) || !hasSectionLabel(label)) continue
      const key = normalizePrefix(oz)
      const previous = labels.get(key)
      labels.set(key, keys.has(key) && (previous === undefined || previous === label) ? label : null)
    }
  }

  const refs = new Map<string, CategoryRef>()
  const grouped = rows.map(({ position, prefixes }) => {
    const path = prefixes.map((prefix) => {
      const key = normalizePrefix(prefix)
      let ref = refs.get(key)
      if (!ref) {
        const title = labels.get(key)
        ref = { oz: key, label: title ? `${prefix} · ${title}` : prefix }
        refs.set(key, ref)
      }
      return ref
    })
    if (!path.length) path.push(ungrouped)
    return { ...position, path, category: path[path.length - 1].label }
  })
  const tree = treeFromPaths(grouped)
  const sortNodes = (nodes: CategoryNode[]) => {
    nodes.sort((a, b) => naturalCompare(a.oz, b.oz))
    for (const node of nodes) sortNodes(node.children)
  }
  sortNodes(tree)
  const { order } = indexTree(tree)
  grouped.sort((a, b) => order.get(leafOz(a))! - order.get(leafOz(b))! || naturalCompare(a.oz, b.oz))
  return { positions: grouped, tree }
}
