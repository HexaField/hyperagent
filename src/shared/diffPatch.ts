import { createPatch } from 'diff'
import type { FileDiff } from '@opencode-ai/sdk'

const resolveFilePath = (value: unknown): string => {
  if (typeof value === 'string' && value.trim().length) {
    return value.trim()
  }
  return 'workspace'
}

const normalizeContent = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

const buildPatchForFile = (diff: FileDiff): string | null => {
  try {
    const filePath = resolveFilePath((diff as Record<string, unknown>).file)
    const before = normalizeContent((diff as Record<string, unknown>).before)
    const after = normalizeContent((diff as Record<string, unknown>).after)
    const patchBody = createPatch(filePath, before, after, `a/${filePath}`, `b/${filePath}`, {
      context: 3
    })
    const trimmed = (patchBody ?? '').trim()
    return trimmed.length ? trimmed : null
  } catch (error) {
    if (typeof console !== 'undefined') {
      console.warn('[diffPatch] failed to create patch from FileDiff', {
        file: (diff as Record<string, unknown>).file,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    return null
  }
}

export const fileDiffsToUnifiedPatch = (files: FileDiff[] | null | undefined): string | null => {
  if (!files || files.length === 0) return null
  const patches: string[] = []
  for (const diff of files) {
    const patch = buildPatchForFile(diff)
    if (patch) patches.push(patch)
  }
  if (!patches.length) return null
  return patches.join('\n\n')
}
