export type Theme = 'light' | 'dark' | 'system'

let systemListener: ((e: MediaQueryListEvent) => void) | null = null

export function getStoredTheme(): Theme | null {
  try {
    const raw = localStorage.getItem('theme')
    if (!raw) return null
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
    return null
  } catch (e) {
    return null
  }
}

function applyDarkClass(should: boolean) {
  if (should) document.documentElement.classList.add('dark')
  else document.documentElement.classList.remove('dark')
}

// callers may pass `null`; runtime entrypoints should default to `'system'` so
// that the UI follows the OS preference and avoids FOUC during initial load
export function applyTheme(theme: Theme | null): (() => void) | undefined {
  // remove previous listener
  if (systemListener) {
    try {
      const mql = window.matchMedia('(prefers-color-scheme: dark)')
      mql.removeEventListener('change', systemListener)
    } catch (e) {
      // ignore
    }
    systemListener = null
  }

  if (!theme || theme === 'light') {
    applyDarkClass(false)
    return
  }

  if (theme === 'dark') {
    applyDarkClass(true)
    return
  }

  // system
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  const update = (ev?: MediaQueryListEvent) => {
    const matches = ev && typeof ev.matches === 'boolean' ? ev.matches : mql.matches
    applyDarkClass(matches)
  }
  // initial
  update()
  systemListener = (e) => update(e)
  try {
    mql.addEventListener('change', systemListener)
  } catch (e) {
    // Safari fallback
    try {
      // @ts-ignore
      mql.addListener(systemListener)
    } catch (err) {
      // ignore
    }
  }

  return () => {
    try {
      mql.removeEventListener('change', systemListener!)
    } catch (e) {
      try {
        // @ts-ignore
        mql.removeListener(systemListener)
      } catch (err) {
        // ignore
      }
    }
    systemListener = null
  }
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem('theme', theme)
  } catch (e) {
    // ignore
  }
  applyTheme(theme)
}
