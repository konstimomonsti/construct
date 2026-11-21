import type { CategoryNode, Position, SourceInfo } from './gaeb'

export type Tone = 'indigo' | 'emerald' | 'amber' | 'blue' | 'sky' | 'violet' | 'slate'

export interface DocMeta {
  id: string
  name: string
  file: string
  pages: number
  excerpt: string
  listId?: string
  stored?: boolean
  original?: boolean
  productEvidence?: boolean
  /** session-only object URL for user uploads */
  blobUrl?: string
}

export interface FolderMeta {
  id: string
  parentId?: string
  name: string
  description: string
  icon: string
  tone: Tone
  lists: string[]
  documents: DocMeta[]
  createdAt?: string
  userCreated?: boolean
}

export interface ListMeta {
  id: string
  folderId: string
  fileName: string
  file?: string
  title: string
  format: string
  phase?: string
  project?: string
  projectLabel?: string
  date?: string
  currency: string
  positionsCount: number
  pricedCount: number
  total: number
  categories: number
  pages?: number
  userCreated?: boolean
}

export interface ListDoc extends ListMeta {
  notes?: string
  positions: Position[]
  /** full category tree in source order (including categories without positions) */
  tree?: CategoryNode[]
  source?: SourceInfo
}

export interface Library {
  generatedAt: string
  folders: FolderMeta[]
  lists: ListMeta[]
}

export type { CategoryNode, Position, SourceInfo }
export type { CategoryRef } from './gaeb'
