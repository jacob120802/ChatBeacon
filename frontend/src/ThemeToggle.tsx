import { useEffect, useState } from 'react'

type Theme = 'light' | 'dark'
const themeStorageKey = 'chatbeacon-theme'

function initialTheme(): Theme {
  try {
    const saved = window.localStorage.getItem(themeStorageKey)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // A blocked storage API should not prevent changing the theme this visit.
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(initialTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      window.localStorage.setItem(themeStorageKey, theme)
    } catch {
      // The visible theme still works when preferences cannot be saved.
    }
  }, [theme])

  return (
    <button
      className="theme-toggle"
      type="button"
      aria-label="Dark theme"
      aria-pressed={theme === 'dark'}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☾' : '☀'}</span>
      <span>Theme</span>
    </button>
  )
}
