import type { JSX } from 'solid-js'
import { createSignal } from 'solid-js'
import DiffViewer from '../components/DiffViewer'

function isJSON(s: string) {
  try {
    JSON.parse(s)
    return true
  } catch {
    return false
  }
}

function renderJson(s: string) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

export default function ToolRenderer(props: { part: any; showHeader?: boolean }): JSX.Element {
  const part = props.part
  const toolName: string = (part.tool ?? part.toolName ?? part.name ?? '').toString()
  const text: string | null = typeof part.text === 'string' ? part.text : null
  const output: string | null =
    typeof (part.state?.output ?? part.output) === 'string' ? (part.state?.output ?? part.output) : null
  const [expanded, setExpanded] = createSignal(false)

  // Per-tool handlers
  function renderNpm(outputText: string) {
    const lines = outputText.split('\n')
    const summary = lines.filter((l) => /added|removed|updated|up to date|audited/i.test(l)).slice(0, 10)
    return (
      <div>
        {summary.length ? (
          <div class="mb-2 text-xs text-[var(--text-muted)]">
            {summary.map((l) => (
              <div>{l}</div>
            ))}
          </div>
        ) : null}
        <pre class="max-h-[360px] overflow-auto whitespace-pre-wrap rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-2 text-xs">
          {expanded()
            ? outputText
            : outputText.length > 2000
              ? outputText.slice(0, 2000) + '\n\n…(truncated)'
              : outputText}
        </pre>
        {outputText.length > 2000 ? (
          <button
            type="button"
            class="mt-2 rounded-md px-2 py-1 text-xs text-blue-600"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded() ? 'Show less' : 'Show more'}
          </button>
        ) : null}
      </div>
    )
  }

  function renderGit(outputText: string) {
    if (/^diff --git/m.test(outputText)) {
      return <DiffViewer diffText={outputText} />
    }
    const lines = outputText.split('\n').slice(0, 200)
    return (
      <pre class="max-h-[360px] overflow-auto whitespace-pre-wrap rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-2 text-xs">
        {lines.join('\n') + (lines.length < outputText.split('\n').length ? '\n\n…(truncated)' : '')}
      </pre>
    )
  }

  function renderShell(outputText: string) {
    const isErr = /error|failed|not found/i.test(outputText)
    return (
      <div>
        <pre
          class={`max-h-[360px] overflow-auto whitespace-pre-wrap rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-2 text-xs ${
            isErr ? 'text-red-600' : ''
          }`}
        >
          {expanded()
            ? outputText
            : outputText.length > 2000
              ? outputText.slice(0, 2000) + '\n\n…(truncated)'
              : outputText}
        </pre>
        {outputText.length > 2000 ? (
          <button
            type="button"
            class="mt-2 rounded-md px-2 py-1 text-xs text-blue-600"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded() ? 'Show less' : 'Show more'}
          </button>
        ) : null}
      </div>
    )
  }

  function renderDefault(outputText: string) {
    if (isJSON(outputText)) {
      return (
        <pre class="whitespace-pre-wrap rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-2 text-xs">
          {renderJson(outputText)}
        </pre>
      )
    }
    return (
      <pre class="max-h-[360px] overflow-auto whitespace-pre-wrap rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-2 text-xs">
        {expanded()
          ? outputText
          : outputText.length > 2000
            ? outputText.slice(0, 2000) + '\n\n…(truncated)'
            : outputText}
      </pre>
    )
  }

  const showHeader = props.showHeader === undefined ? true : !!props.showHeader

  if (output) {
    const lowered = toolName.toLowerCase()
    if (lowered.includes('npm') || (text && /npm/i.test(text))) {
      return (
        <div>
          {showHeader ? <div class="font-medium mb-1">{toolName || 'npm'}</div> : null}
          {renderNpm(output)}
        </div>
      )
    }

    if (lowered.includes('git') || (text && /git/i.test(text))) {
      return (
        <div>
          {showHeader ? <div class="font-medium mb-1">{toolName || 'git'}</div> : null}
          {renderGit(output)}
        </div>
      )
    }

    if (
      lowered.includes('sh') ||
      lowered.includes('bash') ||
      lowered.includes('shell') ||
      (text && /\$\s|npm install|yarn/i.test(text))
    ) {
      return (
        <div>
          {showHeader ? <div class="font-medium mb-1">{toolName || 'shell'}</div> : null}
          {renderShell(output)}
        </div>
      )
    }

    if (part.type === 'file-diff' || part.type === 'diff' || /diff --git/.test(output)) {
      return (
        <div>
          {showHeader ? <div class="font-medium mb-1">Diff</div> : null}
          <DiffViewer diffText={output} />
        </div>
      )
    }

    return (
      <div>
        {showHeader ? <div class="font-medium mb-1">{toolName || 'Tool'}</div> : null}
        {renderDefault(output)}
      </div>
    )
  }

  if (text) {
    return (
      <div>
        {showHeader ? <div class="font-medium mb-1">{toolName || 'Tool'}</div> : null}
        <p class="mb-1 last:mb-0 break-words">{text}</p>
      </div>
    )
  }

  return (
    <div>
      {showHeader ? <div class="font-medium mb-1">{toolName || 'Tool'}</div> : null}
      <p class="text-xs text-[var(--text-muted)]">No output captured.</p>
    </div>
  )
}
