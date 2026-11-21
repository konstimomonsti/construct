import { PageFrame, PageHeader } from '../components/Kit'
import { useStore } from '../lib/store'
import { useTheme } from '../lib/theme'

export function Settings() {
  const [theme, setTheme] = useTheme()
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useStore((s) => s.toggleSidebar)

  return (
    <PageFrame>
      <PageHeader title="Settings" subtitle="Preferences for this browser" />
      <div className="max-w-xl divide-y divide-slate-200 rounded-lg border border-slate-200">
        <label className="flex min-h-16 items-center justify-between gap-4 px-4 py-3 text-[15px] font-medium text-slate-900">
          Theme
          <select
            value={theme}
            onChange={(event) => setTheme(event.currentTarget.value === 'dark' ? 'dark' : 'light')}
            className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm"
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <label className="flex min-h-16 items-center justify-between gap-4 px-4 py-3 text-[15px] font-medium text-slate-900">
          Compact sidebar on desktop
          <input type="checkbox" checked={sidebarCollapsed} onChange={toggleSidebar} className="size-4 accent-brand-700" />
        </label>
      </div>
    </PageFrame>
  )
}
