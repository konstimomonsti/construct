import { FolderCollection } from './AllProjects'
import type { FolderView } from '../lib/store'

const isArchived = (f: FolderView) => f.archived

export function Archived() {
  return (
    <FolderCollection
      title="Archived"
      crumb="Archived"
      subtitle="Archived projects don't count toward totals"
      filter={isArchived}
      emptyIcon="archive"
      emptyTitle="Nothing archived"
      emptyText="Archive a project from its More options menu to set it aside."
    />
  )
}
