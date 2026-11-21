import { Icon } from '../components/ui'
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
      archive
      emptyIcon="archive"
      emptyTitle="Nothing archived"
      emptyText={<>Archive a project from its <Icon name="more_horiz" size={18} className="align-[-4px]" /><span className="sr-only">options</span> menu on All Projects to set it aside. Archived projects don't count toward totals, and you can restore them any time.</>}
    />
  )
}
