import { render, screen } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import DiffViewer from '../DiffViewer'

describe('DiffViewer', () => {
  it('renders collapsible file structure', () => {
    const diffText = `diff --git a/test.txt b/test.txt
@@ -1,3 +1,4 @@
 line 1
 line 2
-line 3
+line 3 modified
+line 4 added`

    render(() => <DiffViewer diffText={diffText} />)

    // Should show file header with collapse indicator
    expect(screen.getByText('test.txt')).toBeDefined()
    expect(screen.getByText('3 changes')).toBeDefined()

    // Should be collapsed by default (▶ indicator)
    expect(screen.getByText('▶')).toBeDefined()

    // Should not show diff content when collapsed
    expect(screen.queryByText('@@ -1,3 +1,4 @@')).toBeNull()
    expect(screen.queryByText('line 1')).toBeNull()
  })

  it('expands to show diff content when clicked', async () => {
    const diffText = `diff --git a/test.txt b/test.txt
@@ -1,3 +1,4 @@
 line 1
 line 2
-line 3
+line 3 modified
+line 4 added`

    render(() => <DiffViewer diffText={diffText} />)

    // Click to expand the first file
    const fileHeaders = screen.getAllByText('test.txt')
    const expandButton = fileHeaders[0].closest('.diff-file-header') as HTMLElement
    expandButton.click()

    // Should show diff content when expanded
    expect(screen.getByText('@@ -1,3 +1,4 @@')).toBeDefined()
    expect(screen.getByText('line 1')).toBeDefined()
    expect(screen.getByText('line 2')).toBeDefined()
    expect(screen.getByText('-line 3')).toBeDefined()
    expect(screen.getByText('+line 3 modified')).toBeDefined()
    expect(screen.getByText('+line 4 added')).toBeDefined()

    // Should show expanded indicator (▼)
    expect(screen.getAllByText('▼')).toHaveLength(1)
  })

  it('handles multiple files', () => {
    const diffText = `diff --git a/file1.txt b/file1.txt
@@ -1 +1 @@
+content1
diff --git a/file2.txt b/file2.txt
@@ -1 +1 @@
+content2`

    render(() => <DiffViewer diffText={diffText} />)

    // Should show both files
    expect(screen.getByText('file1.txt')).toBeDefined()
    expect(screen.getByText('file2.txt')).toBeDefined()
    expect(screen.getAllByText('1 changes')).toHaveLength(2)
  })

  it('shows fallback message when no diff', () => {
    render(() => <DiffViewer diffText={null} />)

    expect(screen.getByText('Select a step with commits to preview the diff.')).toBeDefined()
  })
})
