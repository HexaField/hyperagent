import { For, Show, createMemo, createSignal } from 'solid-js'

type DiffViewerProps = {
  diffText?: string | null
}

type DiffLine = {
  content: string
  type: 'header' | 'hunk' | 'addition' | 'deletion' | 'context'
  lineNumber?: number
}

type DiffFile = {
  header: string
  filePath: string
  hunks: DiffHunk[]
  isExpanded: boolean
}

type DiffHunk = {
  header: string
  lines: DiffLine[]
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
}

export default function DiffViewer(props: DiffViewerProps) {
  const [expandedFiles, setExpandedFiles] = createSignal<Set<string>>(new Set())
  const files = createMemo<DiffFile[]>(() => parseDiffIntoFiles(props.diffText ?? ''))

  const toggleFile = (filePath: string) => {
    const current = expandedFiles()
    const newSet = new Set(current)
    if (newSet.has(filePath)) {
      newSet.delete(filePath)
    } else {
      newSet.add(filePath)
    }
    setExpandedFiles(newSet)
  }

  return (
    <div class="diff-viewer rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)]">
      <Show
        when={props.diffText}
        fallback={<p class="p-4 text-sm text-[var(--text-muted)]">Select a step with commits to preview the diff.</p>}
      >
        <For each={files()}>
          {(file) => (
            <div class="diff-file border-b border-[var(--border)] last:border-b-0">
              <div
                class="diff-file-header flex items-center justify-between p-3 cursor-pointer hover:bg-[var(--bg-hover)] transition-colors"
                onClick={() => toggleFile(file.filePath)}
              >
                <div class="flex items-center gap-2">
                  <span class="text-sm text-[var(--text-muted)]">
                    {expandedFiles().has(file.filePath) ? '▼' : '▶'}
                  </span>
                  <span class="text-sm font-medium text-[var(--text)]">{file.filePath}</span>
                </div>
                <span class="text-xs text-[var(--text-muted)]">
                  {file.hunks.reduce(
                    (acc, hunk) =>
                      acc + hunk.lines.filter((l) => l.type === 'addition' || l.type === 'deletion').length,
                    0
                  )}{' '}
                  changes
                </span>
              </div>

              <Show when={expandedFiles().has(file.filePath)}>
                <div class="diff-file-content">
                  <For each={file.hunks}>
                    {(hunk) => (
                      <div class="diff-hunk">
                        <div class="diff-hunk-header px-4 py-1 text-xs text-[var(--text-muted)] bg-[var(--bg-subtle)] border-b border-[var(--border)]">
                          {hunk.header}
                        </div>
                        <pre class="diff-pre">
                          <For each={hunk.lines}>
                            {(line) => (
                              <code classList={lineClass(line.type)}>
                                <Show when={line.lineNumber !== undefined}>
                                  <span class="diff-line-number select-none text-xs text-[var(--text-muted)] w-8 inline-block text-right pr-2">
                                    {line.lineNumber}
                                  </span>
                                </Show>
                                {line.content}
                              </code>
                            )}
                          </For>
                        </pre>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}

function parseDiffIntoFiles(raw: string): DiffFile[] {
  if (!raw.trim()) return []

  const lines = raw.split('\n')
  const files: DiffFile[] = []
  let currentFile: DiffFile | null = null
  let currentHunk: DiffHunk | null = null
  let oldLineNumber = 0
  let newLineNumber = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.startsWith('diff --git') || line.startsWith('Index:') || line.startsWith('***')) {
      // Save previous file if exists
      if (currentFile) {
        files.push(currentFile)
      }

      // Try multiple header styles: git diff or unified Index/---/+++ style
      let filePath = 'unknown'
      if (line.startsWith('diff --git')) {
        const match = line.match(/diff --git a\/(.+) b\/(.+)/)
        filePath = match ? match[1] : filePath
      } else if (line.startsWith('Index:')) {
        const match = line.match(/Index:\s*(.+)/)
        filePath = match ? match[1].trim() : filePath
      }

      currentFile = {
        header: line,
        filePath,
        hunks: [],
        isExpanded: false
      }
      currentHunk = null
    } else if (line.startsWith('@@') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      if (!currentFile) continue

      // Parse hunk header: @@ -oldStart,oldLines +newStart,newLines @@
      const hunkMatch = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (hunkMatch) {
        const oldStart = parseInt(hunkMatch[1])
        const oldLines = parseInt(hunkMatch[2] || '1')
        const newStart = parseInt(hunkMatch[3])
        const newLines = parseInt(hunkMatch[4] || '1')

        currentHunk = {
          header: line,
          lines: [],
          oldStart,
          oldLines,
          newStart,
          newLines
        }
        currentFile.hunks.push(currentHunk)

        oldLineNumber = oldStart
        newLineNumber = newStart
      }
    } else if (currentHunk) {
      let diffLine: DiffLine

      if (line.startsWith('+')) {
        diffLine = { content: line, type: 'addition', lineNumber: newLineNumber }
        newLineNumber++
      } else if (line.startsWith('-')) {
        diffLine = { content: line, type: 'deletion', lineNumber: oldLineNumber }
        oldLineNumber++
      } else if (line.startsWith(' ')) {
        diffLine = { content: line, type: 'context', lineNumber: newLineNumber }
        oldLineNumber++
        newLineNumber++
      } else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        // file markers — ignore but keep context
        diffLine = { content: line, type: 'header' }
      } else {
        // fallback: treat as context
        diffLine = { content: line, type: 'context', lineNumber: newLineNumber }
        oldLineNumber++
        newLineNumber++
      }

      currentHunk.lines.push(diffLine)
    }
  }

  // Add last file if exists
  if (currentFile) {
    files.push(currentFile)
  }

  return files
}

function lineClass(type: DiffLine['type']) {
  return {
    'diff-line': true,
    'diff-line-header': type === 'header',
    'diff-line-hunk': type === 'hunk',
    'diff-line-addition': type === 'addition',
    'diff-line-deletion': type === 'deletion'
  }
}
