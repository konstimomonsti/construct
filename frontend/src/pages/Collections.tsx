import { FolderCollection } from './AllProjects'
import type { FolderView } from '../lib/store'

const isArchived = (f: FolderView) => f.archived

export function Archived() {
  return (
    <FolderCollection
      title="Archived"
      crumb="Archived"
      filter={isArchived}
      emptyIcon="archive"
      emptyTitle="Nothing archived"
      emptyText="Archive a folder from its menu (⋮) and it will be kept here, out of your active projects."
    />
  )
}
