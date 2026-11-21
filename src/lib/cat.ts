import type { CategoryNode, Position } from './gaeb'

/** helper to build a CategoryNode */
export function newNode(oz: string, label: string): CategoryNode {
  return { oz, label, depth: oz.split('.').filter(Boolean).length || 1, children: [] }
}

/** flat tree from category labels (csv / json / docx / blank lists): synthetic OZ '1','2',… (sets p.path) */
export function flatTree(positions: Position[]): CategoryNode[] {
  const byLabel = new Map<string, CategoryNode>()
  const tree: CategoryNode[] = []
  for (const p of positions) {
    let n = byLabel.get(p.category)
    if (!n) {
      n = newNode(String(tree.length + 1), p.category)
      byLabel.set(p.category, n)
      tree.push(n)
    }
    p.path = [{ oz: n.oz, label: n.label }]
  }
  return tree
}

/** rebuild a tree from positions' path chains (order of first appearance) */
export function treeFromPaths(positions: Position[]): CategoryNode[] {
  const tree: CategoryNode[] = []
  const byOz = new Map<string, CategoryNode>()
  for (const p of positions) {
    let parent: CategoryNode | null = null
    for (const r of p.path ?? []) {
      let n = byOz.get(r.oz)
      if (!n) {
        n = newNode(r.oz, r.label)
        n.depth = (parent?.depth ?? 0) + 1
        byOz.set(r.oz, n)
        ;(parent ? parent.children : tree).push(n)
      }
      parent = n
    }
  }
  return tree
}
