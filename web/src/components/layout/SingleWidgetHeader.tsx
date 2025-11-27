import { For, Show, createSignal, onCleanup, onMount } from 'solid-js'
import { WIDGET_TEMPLATES } from '../../constants/widgetTemplates'
import ThemeToggle from '../ThemeToggle'

export type SingleWidgetHeaderProps = {
  title?: () => string
  hideHeader?: () => boolean
}

export default function SingleWidgetHeader(
  props: SingleWidgetHeaderProps & { onBack?: () => void; backLabel?: string }
) {
  const [widgetMenuOpen, setWidgetMenuOpen] = createSignal(false)
  const [settingsOpen, setSettingsOpen] = createSignal(false)

  onMount(() => {
    const keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (widgetMenuOpen()) setWidgetMenuOpen(false)
        if (settingsOpen()) setSettingsOpen(false)
      }
    }
    if (typeof window !== 'undefined') window.addEventListener('keydown', keydownHandler)
    onCleanup(() => {
      try {
        if (typeof window !== 'undefined') window.removeEventListener('keydown', keydownHandler)
      } catch {}
    })
  })

  const openSingleWidgetByTemplate = (templateId: string) => {
    try {
      if (typeof window === 'undefined') return
      window.dispatchEvent(new CustomEvent('workspace:open-single-widget', { detail: { templateId } }))
    } catch {}
  }

  const titleText = () => (props.title ? props.title() : '')

  return (
    <header class="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--bg-muted)] px-4 py-3">
      <Show when={!props.hideHeader?.()}>
        <div class="flex items-center justify-between gap-3">
          <div class="relative w-1/4">
            <Show when={props.onBack}>
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-3 py-1 text-sm font-semibold"
                onClick={() => props.onBack && props.onBack()}
              >
                {props.backLabel ?? '←'}
              </button>
            </Show>
            <Show when={!props.onBack}>
              <div class="relative">
                <button
                  type="button"
                  class="inline-flex items-center gap-2 rounded-full border border-[var(--border)] px-3 py-1 text-sm font-semibold"
                  aria-label="Open widgets menu"
                  onClick={() => setWidgetMenuOpen((v) => !v)}
                >
                  ☰
                </button>
                <Show when={widgetMenuOpen()}>
                  <>
                    <button
                      type="button"
                      class="fixed inset-0"
                      aria-label="Close widget menu"
                      onClick={() => setWidgetMenuOpen(false)}
                    />
                    <div class="fixed left-0 right-0 top-12 z-50 max-w-none border-t border-b border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-lg">
                      <For each={WIDGET_TEMPLATES}>
                        {(template) => (
                          <button
                            type="button"
                            class="w-full text-left rounded-md px-3 py-2 text-sm hover:bg-[var(--bg-muted)]"
                            onClick={() => {
                              openSingleWidgetByTemplate(template.id)
                              setWidgetMenuOpen(false)
                            }}
                          >
                            {template.label}
                          </button>
                        )}
                      </For>
                    </div>
                  </>
                </Show>
              </div>
            </Show>
          </div>

          <div class="flex-1 text-center text-sm font-semibold">{titleText()}</div>

          <div class="relative w-1/4 flex items-center justify-end">
            <div class="relative">
              <button
                type="button"
                class="inline-flex items-center gap-2 rounded-full border border-[var(--border)] px-3 py-1 text-sm"
                aria-label="Open widget settings"
                onClick={() => setSettingsOpen((v) => !v)}
              >
                ⚙️
              </button>
              <Show when={settingsOpen()}>
                <>
                  <button
                    type="button"
                    class="fixed inset-0"
                    aria-label="Close settings"
                    onClick={() => setSettingsOpen(false)}
                  />
                  <div class="absolute right-0 mt-2 w-56 z-50 rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-lg">
                    <p class="text-xs text-[var(--text-muted)] mb-2">Display</p>
                    <ThemeToggle />
                  </div>
                </>
              </Show>
            </div>
          </div>
        </div>
      </Show>
    </header>
  )
}
