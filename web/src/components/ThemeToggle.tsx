import { createSignal, onCleanup } from 'solid-js'
import { getStoredTheme, applyTheme, setTheme, Theme } from '../lib/theme'

export default function ThemeToggle() {
  const initial = getStoredTheme() ?? 'system'
  const [theme, setLocal] = createSignal<Theme>(initial)

  let cleanup: (() => void) | undefined

  const apply = (t: Theme) => {
    setLocal(t)
    if (cleanup) cleanup()
    cleanup = applyTheme(t)
  }

  const onChange = (e: Event) => {
    const v = (e.currentTarget as HTMLInputElement).value as Theme
    setTheme(v)
    apply(v)
  }

  // ensure runtime listener is set
  apply(theme())

  onCleanup(() => {
    if (cleanup) cleanup()
  })

  return (
    <div class="flex items-center gap-2">
      <label class="text-sm text-[var(--text-muted)]">Theme</label>
      <select class="rounded-md border border-[var(--border)] bg-[var(--bg-muted)] px-2 py-1 text-[var(--text)]" value={theme()} onChange={onChange}>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
        <option value="system">System</option>
      </select>
    </div>
  )
}
