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
      emptyText={<>Choose Archive from a project's <span className="whitespace-nowrap">More options (<Icon name="more_horiz" size={18} className="align-[-4px]" />)</span> menu on All Projects. Archived projects don't count toward totals. You can restore them at any time.</>}
    />
  )
}
