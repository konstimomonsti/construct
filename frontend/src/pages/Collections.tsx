import { FolderCollection } from './AllProjects'
import type { FolderView } from '../lib/store'

const isArchived = (f: FolderView) => f.archived
const isShared = (f: FolderView) => f.shared

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

export function Shared() {
  return (
    <FolderCollection
      title="Shared with Team"
      crumb="Shared with Team"
      filter={isShared}
      emptyIcon="group"
      emptyTitle="No folders shared yet"
      emptyText="Use “Share with team” in a folder's menu (⋮) to list it here."
    />
  )
}
