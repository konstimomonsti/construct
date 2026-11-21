import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'

const KEY = 'billbuild-theme'
const listeners = new Set<() => void>()

/** light unless the person picked dark; index.html applies it before first paint */
function read(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export function setTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === 'dark') root.dataset.theme = 'dark'
  else delete root.dataset.theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0d0502' : '#ffffff')
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* private mode: the choice lasts for this page only */
  }
  listeners.forEach((l) => l())
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    read,
    () => 'light' as Theme,
  )
  return [theme, setTheme]
}
