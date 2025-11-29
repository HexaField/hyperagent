import { createEffect, createSignal, onCleanup } from 'solid-js'

type Theme = 'light' | 'dark' | 'system'
const STORAGE_KEY = 'theme'

function applyTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    if (prefersDark) root.classList.add('dark')
    else root.classList.remove('dark')
  } else if (theme === 'dark') {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
}

export default function ThemeToggle() {
  const [theme, setTheme] = createSignal<Theme>('system')

  createEffect(() => {
    if (typeof window === 'undefined') return
    const stored = window.localStorage.getItem(STORAGE_KEY) as Theme | null
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      setTheme(stored)
      applyTheme(stored)
    } else {
      setTheme('system')
      applyTheme('system')
    }
  })

  // listen for system preference changes when in system mode
  let mql: any = null
  let systemHandler: ((e: MediaQueryListEvent) => void) | null = null

  const watchSystem = (shouldWatch: boolean) => {
    if (typeof window === 'undefined') return
    if (mql == null) mql = window.matchMedia('(prefers-color-scheme: dark)')
    if (!mql) return

    // create a stable handler so we can remove it later
    if (!systemHandler) systemHandler = () => applyTheme('system')

    if (shouldWatch) {
      if (typeof mql.addEventListener === 'function') mql.addEventListener('change', systemHandler)
      else if (typeof mql.addListener === 'function') mql.addListener(systemHandler)
    } else {
      if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', systemHandler)
      else if (typeof mql.removeListener === 'function') mql.removeListener(systemHandler)
    }
  }

  createEffect(() => {
    const t = theme()
    if (typeof window === 'undefined') return
    window.localStorage.setItem(STORAGE_KEY, t)
    applyTheme(t)
    watchSystem(t === 'system')
  })

  onCleanup(() => {
    if (mql && systemHandler) {
      try {
        if ('removeEventListener' in mql) mql.removeEventListener('change', systemHandler)
        else mql.removeListener(systemHandler as any)
      } catch {}
    }
  })

  const set = (t: Theme) => setTheme(t)

  return (
    <div class="flex items-center gap-2">
      <button
        type="button"
        class="rounded-xl border border-[var(--border)] px-3 py-1 text-sm"
        classList={{ 'bg-blue-600 text-white': theme() === 'light' }}
        aria-pressed={theme() === 'light'}
        title="Light theme"
        onClick={() => set('light')}
      >
        Light
      </button>
      <button
        type="button"
        class="rounded-xl border border-[var(--border)] px-3 py-1 text-sm"
        classList={{ 'bg-blue-600 text-white': theme() === 'system' }}
        aria-pressed={theme() === 'system'}
        title="System theme"
        onClick={() => set('system')}
      >
        System
      </button>
      <button
        type="button"
        class="rounded-xl border border-[var(--border)] px-3 py-1 text-sm"
        classList={{ 'bg-blue-600 text-white': theme() === 'dark' }}
        aria-pressed={theme() === 'dark'}
        title="Dark theme"
        onClick={() => set('dark')}
      >
        Dark
      </button>
    </div>
  )
}
