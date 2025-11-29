import { describe, expect, it } from 'vitest'
import { extractDiffText } from '../messageParts'

describe('extractDiffText', () => {
  it('detects diff in part.text', () => {
    const part: any = { text: 'diff --git a/file b/file\n@@ -1 +1 @@\n-foo\n+bar' }
    expect(extractDiffText(part)).toContain('diff --git')
  })

  it('detects diff in part.diff', () => {
    const part: any = { diff: 'Index: example\n@@ -1 +1 @@\n-foo\n+bar' }
    expect(extractDiffText(part)).toContain('Index:')
  })

  it('detects diff in part.payload', () => {
    const part: any = { payload: '@@ -1 +1 @@\n-foo\n+bar' }
    expect(extractDiffText(part)).toContain('@@')
  })

  it('detects diff in state.output', () => {
    const part: any = { state: { output: 'diff --git a/x b/x\n@@ -1 +1 @@\n-foo\n+bar' } }
    expect(extractDiffText(part)).toContain('diff --git')
  })

  it('detects diff in state.metadata.diff', () => {
    const part: any = { state: { metadata: { diff: 'diff --git a/x b/x\n@@ -1 +1 @@\n-foo\n+bar' } } }
    expect(extractDiffText(part)).toContain('diff --git')
  })

  it('returns null when no diff present', () => {
    const part: any = { text: 'just some text' }
    expect(extractDiffText(part)).toBeNull()
  })
})
