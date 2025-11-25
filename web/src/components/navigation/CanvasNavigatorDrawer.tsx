import { Show } from 'solid-js'
import { useCanvasNavigator } from '../../contexts/CanvasNavigatorContext'
import RepositoryNavigator from './RepositoryNavigator'

export default function CanvasNavigatorDrawer() {
  const controller = useCanvasNavigator()

  return (
    <>
      <button
        type="button"
        aria-label="Toggle canvas navigator"
        class="fixed left-4 top-1/2 z-30 -translate-y-1/2 rounded-full border border-[var(--border)] bg-[var(--bg-card)] px-4 py-2 text-sm font-semibold text-[var(--text)] shadow-[0_12px_24px_rgba(15,23,42,0.25)] transition hover:border-blue-500"
        classList={{ 'pointer-events-none opacity-0': controller.isOpen() }}
        onClick={() => controller.toggle()}
      >
        Canvas navigator
      </button>
      <Show when={controller.isOpen()}>
        <div class="fixed inset-0 z-40 flex">
          <div class="flex-1 bg-black/40" role="presentation" onClick={() => controller.close()} />
          <aside class="relative flex h-full w-full max-w-[420px] flex-col bg-[var(--bg-app)] text-[var(--text)] shadow-[0_0_40px_rgba(15,23,42,0.35)]">
            <header class="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
              <div>
                <p class="text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">Navigator</p>
                <h1 class="text-xl font-semibold">Canvas drawer</h1>
              </div>
              <button
                type="button"
                class="rounded-full border border-[var(--border)] px-3 py-1 text-sm"
                onClick={() => controller.close()}
              >
                Close
              </button>
            </header>
            <div class="flex-1 overflow-auto">
              <section class="px-5 py-4">
                <RepositoryNavigator />
              </section>
            </div>
          </aside>
        </div>
      </Show>
    </>
  )
}
