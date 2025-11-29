import { For, Show } from 'solid-js'

export type TodoItem = {
  content: string
  id: string
  priority: 'high' | 'medium' | 'low'
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

export default function TodoList(props: { todos: TodoItem[] }) {
  return (
    <div class="max-w-xl rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-sm font-semibold">Todo</h3>
        <span class="text-xs text-[var(--text-muted)]">{props.todos.length} items</span>
      </div>

      <For each={props.todos}>
        {(todo) => (
          <div class="flex items-start gap-3 py-2 border-t border-[var(--border)] first:border-t-0">
            <div class="mt-0.5">
              <Show
                when={todo.status === 'completed'}
                fallback={<div class="w-4 h-4 rounded-full border border-[var(--border)] bg-[var(--bg-muted)]" />}
              >
                <div class="w-4 h-4 rounded-full bg-green-500" />
              </Show>
            </div>

            <div class="flex-1">
              <div class="flex items-center justify-between gap-3">
                <p class="text-sm">{todo.content}</p>
                <div class="flex items-center gap-2">
                  <span
                    classList={{
                      'text-xs px-2 py-0.5 rounded-full': true,
                      'bg-red-50 text-red-700': todo.priority === 'high',
                      'bg-yellow-50 text-yellow-700': todo.priority === 'medium',
                      'bg-green-50 text-green-700': todo.priority === 'low'
                    }}
                  >
                    {todo.priority}
                  </span>
                  <span class="text-xs text-[var(--text-muted)]">{todo.status.replace('_', ' ')}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </For>
    </div>
  )
}
