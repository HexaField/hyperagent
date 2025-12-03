import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpencodeStorage, resolveDefaultOpencodeRoot } from './provider'

const fixtureRoot = path.join(process.cwd(), 'tests', 'fixtures/opencode-storage')

describe('createOpencodeStorage', () => {
  it('lists sessions sorted by updatedAt and filters by workspace path', async () => {
    const storage = createOpencodeStorage({ rootDir: fixtureRoot })
    const sessions = await storage.listSessions()
    expect(sessions.map((session) => session.id)).toEqual(['ses_beta', 'ses_alpha', 'ses_tool'])

    const filtered = await storage.listSessions({ workspacePath: '/workspace/repo-alpha' })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].id).toBe('ses_alpha')
    expect(filtered[0].summary).toEqual({ additions: 3, deletions: 1, files: 1 })
  })

  it('returns session detail with message transcripts', async () => {
    const storage = createOpencodeStorage({ rootDir: fixtureRoot })
    const detail = await storage.getSession('ses_alpha')
    expect(detail).not.toBeNull()
    expect(detail?.session.title).toBe('Alpha Session')
    expect(detail?.messages).toHaveLength(2)
    const assistant = detail?.messages.find((message) => message.role === 'assistant')
    // after removing fallback flat text, the structured `parts` should contain the outline
    const textPart = assistant?.parts.find((p) => p.type === 'text' && typeof p.text === 'string')
    expect(textPart && (textPart.text as string)).toContain('Outlined plan')
    expect(assistant?.modelId).toBe('github-copilot/gpt-5-mini')
  })

  it('includes tool, step-start, and step-finish parts in message text', async () => {
    const storage = createOpencodeStorage({ rootDir: fixtureRoot })
    const detail = await storage.getSession('ses_tool')
    expect(detail).not.toBeNull()
    expect(detail?.session.title).toBe('Tool Session')
    expect(detail?.messages).toHaveLength(1)
    const assistant = detail?.messages.find((message) => message.role === 'assistant')
    // details should now be present as structured parts
    const toolPart = assistant?.parts.find((p) => p.type === 'tool')
    const startPart = assistant?.parts.find((p) => p.type === 'step-start')
    const finishPart = assistant?.parts.find((p) => p.type === 'step-finish')
    expect(toolPart && (toolPart.text as string)).toContain('Running npm install')
    expect(startPart && (startPart.text as string)).toContain('Installing dependencies')
    expect(finishPart && (finishPart.text as string)).toContain('Dependencies installed successfully')
  })

  it('extracts UI-friendly tool calls and timeline from messages', async () => {
    const storage = createOpencodeStorage({ rootDir: fixtureRoot })
    const detail = await storage.getSession('ses_tool')
    expect(detail).not.toBeNull()
    if (!detail) return

    const msg = detail.messages[0]
    // UI mapping: extract tool calls with metadata and durations
    const toolCalls = msg.parts
      .filter((p) => p.type === 'tool')
      .map((p) => ({ id: p.id, text: p.text ?? '', start: p.start, end: p.end }))
    expect(toolCalls.length).toBeGreaterThanOrEqual(1)
    const call = toolCalls[0]
    expect(call.text).toBe('Running npm install')
    expect(typeof call.start).toBe('string')
    expect(typeof call.end).toBe('string')
    const durationMs = Date.parse(call.end as string) - Date.parse(call.start as string)
    expect(durationMs).toBeGreaterThanOrEqual(0)

    // Timeline: include step-start and step-finish as events in order
    const timeline = msg.parts
      .filter((p) => p.type === 'step-start' || p.type === 'step-finish')
      .map((p) => ({ id: p.id, type: p.type, text: p.text ?? '', time: p.start ?? p.end }))
    expect(timeline.length).toBeGreaterThanOrEqual(2)
    const startEvent = timeline.find((t) => t.type === 'step-start')
    const finishEvent = timeline.find((t) => t.type === 'step-finish')
    expect(startEvent).toBeDefined()
    expect(finishEvent).toBeDefined()
    if (startEvent && finishEvent) {
      expect(Date.parse(startEvent.time as string)).toBeLessThanOrEqual(Date.parse(finishEvent.time as string))
    }
  })

  it('normalizes step events wrapped inside JSON text blobs', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opencode-step-json-'))
    try {
      const storageDir = path.join(tmpRoot, 'storage')
      const sessionDir = path.join(storageDir, 'session', 'hash-step')
      const messageDir = path.join(storageDir, 'message', 'ses_json')
      const partDir = path.join(storageDir, 'part', 'msg_json')
      await fs.promises.mkdir(sessionDir, { recursive: true })
      await fs.promises.mkdir(messageDir, { recursive: true })
      await fs.promises.mkdir(partDir, { recursive: true })

      const now = Date.now()
      const sessionJson = {
        id: 'ses_json',
        directory: '/workspace/json-repo',
        title: 'JSON Step Session',
        time: { created: now, updated: now },
        summary: { additions: 0, deletions: 0, files: 0 }
      }
      await fs.promises.writeFile(path.join(sessionDir, 'ses_json.json'), JSON.stringify(sessionJson), 'utf8')

      const messageJson = {
        id: 'msg_json',
        sessionID: 'ses_json',
        role: 'assistant',
        time: { created: now, completed: now },
        modelID: 'mock-model',
        providerID: 'opencode'
      }
      await fs.promises.writeFile(path.join(messageDir, 'msg_json.json'), JSON.stringify(messageJson), 'utf8')

      const stepPayload = {
        type: 'step_start',
        timestamp: now,
        part: {
          id: 'prt_ref',
          sessionID: 'ses_json',
          messageID: 'msg_json',
          type: 'step-start',
          text: 'Installing dependencies'
        }
      }
      const partJson = {
        id: 'prt_wrapped',
        sessionID: 'ses_json',
        messageID: 'msg_json',
        type: 'tool',
        text: JSON.stringify(stepPayload),
        time: { start: now, end: now }
      }
      await fs.promises.writeFile(path.join(partDir, 'prt_wrapped.json'), JSON.stringify(partJson), 'utf8')

      const storage = createOpencodeStorage({ rootDir: tmpRoot })
      const detail = await storage.getSession('ses_json')
      expect(detail).not.toBeNull()
      if (!detail) return
      const message = detail.messages.find((m) => m.id === 'msg_json')
      expect(message).toBeDefined()
      const part = message?.parts.find((p) => p.id === 'prt_wrapped')
      expect(part).toBeDefined()
      expect(part?.type).toBe('step-start')
      expect(part?.text).toBe('Installing dependencies')
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it('adds fallback summaries for step events without explicit text', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opencode-step-meta-'))
    try {
      const storageDir = path.join(tmpRoot, 'storage')
      const sessionDir = path.join(storageDir, 'session', 'hash-step-meta')
      const messageDir = path.join(storageDir, 'message', 'ses_meta')
      const partDir = path.join(storageDir, 'part', 'msg_meta')
      await fs.promises.mkdir(sessionDir, { recursive: true })
      await fs.promises.mkdir(messageDir, { recursive: true })
      await fs.promises.mkdir(partDir, { recursive: true })

      const now = Date.now()
      const sessionJson = {
        id: 'ses_meta',
        directory: '/workspace/meta-repo',
        title: 'Meta Step Session',
        time: { created: now, updated: now },
        summary: { additions: 0, deletions: 0, files: 0 }
      }
      await fs.promises.writeFile(path.join(sessionDir, 'ses_meta.json'), JSON.stringify(sessionJson), 'utf8')

      const messageJson = {
        id: 'msg_meta',
        sessionID: 'ses_meta',
        role: 'assistant',
        time: { created: now, completed: now },
        modelID: 'mock-model',
        providerID: 'opencode'
      }
      await fs.promises.writeFile(path.join(messageDir, 'msg_meta.json'), JSON.stringify(messageJson), 'utf8')

      const partJson = {
        id: 'prt_meta',
        sessionID: 'ses_meta',
        messageID: 'msg_meta',
        type: 'step-start',
        text: '',
        snapshot: 'abc123',
        time: { start: now, end: now }
      }
      await fs.promises.writeFile(path.join(partDir, 'prt_meta.json'), JSON.stringify(partJson), 'utf8')

      const storage = createOpencodeStorage({ rootDir: tmpRoot })
      const detail = await storage.getSession('ses_meta')
      expect(detail).not.toBeNull()
      if (!detail) return
      const message = detail.messages.find((m) => m.id === 'msg_meta')
      const part = message?.parts.find((p) => p.id === 'prt_meta')
      expect(part?.type).toBe('step-start')
      expect(part?.text).toBe('Snapshot: abc123')
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it('hydrates snapshot-backed steps when a resolver provides text', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opencode-step-snapshot-'))
    try {
      const storageDir = path.join(tmpRoot, 'storage')
      const sessionDir = path.join(storageDir, 'session', 'hash-step-snap')
      const messageDir = path.join(storageDir, 'message', 'ses_snap')
      const partDir = path.join(storageDir, 'part', 'msg_snap')
      await fs.promises.mkdir(sessionDir, { recursive: true })
      await fs.promises.mkdir(messageDir, { recursive: true })
      await fs.promises.mkdir(partDir, { recursive: true })

      const now = Date.now()
      const sessionJson = {
        id: 'ses_snap',
        directory: '/workspace/snapshot-repo',
        title: 'Snapshot Step Session',
        time: { created: now, updated: now },
        summary: { additions: 0, deletions: 0, files: 0 }
      }
      await fs.promises.writeFile(path.join(sessionDir, 'ses_snap.json'), JSON.stringify(sessionJson), 'utf8')

      const messageJson = {
        id: 'msg_snap',
        sessionID: 'ses_snap',
        role: 'assistant',
        time: { created: now, completed: now },
        modelID: 'mock-model',
        providerID: 'opencode'
      }
      await fs.promises.writeFile(path.join(messageDir, 'msg_snap.json'), JSON.stringify(messageJson), 'utf8')

      const partJson = {
        id: 'prt_snap',
        sessionID: 'ses_snap',
        messageID: 'msg_snap',
        type: 'step-start',
        text: '',
        snapshot: 'deadbeef',
        time: { start: now, end: now }
      }
      await fs.promises.writeFile(path.join(partDir, 'prt_snap.json'), JSON.stringify(partJson), 'utf8')

      const resolver = {
        extractStepText: vi.fn().mockResolvedValue('Resolved snapshot output')
      }

      const storage = createOpencodeStorage({ rootDir: tmpRoot, snapshotResolver: resolver })
      const detail = await storage.getSession('ses_snap')
      expect(detail).not.toBeNull()
      if (!detail) return
      const message = detail.messages.find((m) => m.id === 'msg_snap')
      const part = message?.parts.find((p) => p.id === 'prt_snap')
      expect(part?.text).toBe('Resolved snapshot output')
      expect(resolver.extractStepText).toHaveBeenCalledWith({
        snapshotHash: 'deadbeef',
        workspacePath: '/workspace/snapshot-repo',
        stage: 'start',
        actor: null
      })
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it('hydrates snapshot-backed steps when the snapshot hash only appears inside nested payload text', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opencode-step-nested-snapshot-'))
    try {
      const storageDir = path.join(tmpRoot, 'storage')
      const sessionDir = path.join(storageDir, 'session', 'hash-step-snap-nested')
      const messageDir = path.join(storageDir, 'message', 'ses_nested_snap')
      const partDir = path.join(storageDir, 'part', 'msg_nested_snap')
      await fs.promises.mkdir(sessionDir, { recursive: true })
      await fs.promises.mkdir(messageDir, { recursive: true })
      await fs.promises.mkdir(partDir, { recursive: true })

      const now = Date.now()
      const sessionJson = {
        id: 'ses_nested_snap',
        directory: '/workspace/nested-snapshot',
        title: 'Nested Snapshot Session',
        time: { created: now, updated: now },
        summary: { additions: 0, deletions: 0, files: 0 }
      }
      await fs.promises.writeFile(path.join(sessionDir, 'ses_nested_snap.json'), JSON.stringify(sessionJson), 'utf8')

      const messageJson = {
        id: 'msg_nested_snap',
        sessionID: 'ses_nested_snap',
        role: 'assistant',
        time: { created: now, completed: now },
        modelID: 'mock-model',
        providerID: 'opencode'
      }
      await fs.promises.writeFile(path.join(messageDir, 'msg_nested_snap.json'), JSON.stringify(messageJson), 'utf8')

      const nestedPayload = {
        type: 'step_start',
        timestamp: now,
        part: {
          id: 'prt_nested_payload',
          sessionID: 'ses_nested_snap',
          messageID: 'msg_nested_snap',
          type: 'step-start',
          snapshot: 'nestedhash'
        }
      }

      const partJson = {
        id: 'prt_nested_wrapper',
        sessionID: 'ses_nested_snap',
        messageID: 'msg_nested_snap',
        type: 'text',
        text: JSON.stringify(nestedPayload),
        time: { start: now, end: now }
      }
      await fs.promises.writeFile(path.join(partDir, 'prt_nested_wrapper.json'), JSON.stringify(partJson), 'utf8')

      const resolver = {
        extractStepText: vi.fn().mockResolvedValue('Nested snapshot text')
      }

      const storage = createOpencodeStorage({ rootDir: tmpRoot, snapshotResolver: resolver })
      const detail = await storage.getSession('ses_nested_snap')
      expect(detail).not.toBeNull()
      if (!detail) return
      const message = detail.messages.find((m) => m.id === 'msg_nested_snap')
      const part = message?.parts.find((p) => p.id === 'prt_nested_wrapper')
      expect(part?.type).toBe('step-start')
      expect(part?.text).toBe('Nested snapshot text')
      expect(resolver.extractStepText).toHaveBeenCalledWith({
        snapshotHash: 'nestedhash',
        workspacePath: '/workspace/nested-snapshot',
        stage: 'start',
        actor: null
      })
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it('passes worker and verifier actor hints to the snapshot resolver', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opencode-step-actor-'))
    try {
      const storageDir = path.join(tmpRoot, 'storage')
      const sessionDir = path.join(storageDir, 'session', 'hash-step-actor')
      const messageDir = path.join(storageDir, 'message', 'ses_actor')
      const partRoot = path.join(storageDir, 'part')
      await fs.promises.mkdir(sessionDir, { recursive: true })
      await fs.promises.mkdir(messageDir, { recursive: true })
      await fs.promises.mkdir(partRoot, { recursive: true })

      const now = Date.now()
      const sessionJson = {
        id: 'ses_actor',
        directory: '/workspace/actor-repo',
        title: 'Actor Session',
        time: { created: now, updated: now },
        summary: { additions: 0, deletions: 0, files: 0 }
      }
      await fs.promises.writeFile(path.join(sessionDir, 'ses_actor.json'), JSON.stringify(sessionJson), 'utf8')

      const workerMessage = {
        id: 'msg_worker',
        sessionID: 'ses_actor',
        role: 'worker',
        time: { created: now, completed: now },
        modelID: 'mock-model',
        providerID: 'opencode'
      }
      const verifierMessage = {
        id: 'msg_verifier',
        sessionID: 'ses_actor',
        role: 'verifier',
        time: { created: now, completed: now },
        modelID: 'mock-model',
        providerID: 'opencode'
      }
      await fs.promises.writeFile(path.join(messageDir, 'msg_worker.json'), JSON.stringify(workerMessage), 'utf8')
      await fs.promises.writeFile(path.join(messageDir, 'msg_verifier.json'), JSON.stringify(verifierMessage), 'utf8')

      const makePart = (id: string) => ({
        id,
        sessionID: 'ses_actor',
        messageID: id.startsWith('prt_worker') ? 'msg_worker' : 'msg_verifier',
        type: 'step-start',
        text: '',
        snapshot: 'cafebabe',
        time: { start: now, end: now }
      })

      const workerPartDir = path.join(partRoot, 'msg_worker')
      const verifierPartDir = path.join(partRoot, 'msg_verifier')
      await fs.promises.mkdir(workerPartDir, { recursive: true })
      await fs.promises.mkdir(verifierPartDir, { recursive: true })
      await fs.promises.writeFile(path.join(workerPartDir, 'prt_worker.json'), JSON.stringify(makePart('prt_worker')), 'utf8')
      await fs.promises.writeFile(
        path.join(verifierPartDir, 'prt_verifier.json'),
        JSON.stringify(makePart('prt_verifier')),
        'utf8'
      )

      const resolver = {
        extractStepText: vi.fn().mockImplementation(async ({ actor }) =>
          actor === 'verifier' ? 'Verifier snapshot text' : actor === 'worker' ? 'Worker snapshot text' : 'Unknown snapshot'
        )
      }

      const storage = createOpencodeStorage({ rootDir: tmpRoot, snapshotResolver: resolver })
      const detail = await storage.getSession('ses_actor')
      expect(detail).not.toBeNull()
      if (!detail) return
      const workerMsg = detail.messages.find((m) => m.id === 'msg_worker')
      const verifierMsg = detail.messages.find((m) => m.id === 'msg_verifier')
      const workerPart = workerMsg?.parts.find((p) => p.id === 'prt_worker')
      const verifierPart = verifierMsg?.parts.find((p) => p.id === 'prt_verifier')
      expect(workerPart?.text).toBe('Worker snapshot text')
      expect(verifierPart?.text).toBe('Verifier snapshot text')

      expect(resolver.extractStepText).toHaveBeenCalledWith({
        snapshotHash: 'cafebabe',
        workspacePath: '/workspace/actor-repo',
        stage: 'start',
        actor: 'worker'
      })
      expect(resolver.extractStepText).toHaveBeenCalledWith({
        snapshotHash: 'cafebabe',
        workspacePath: '/workspace/actor-repo',
        stage: 'start',
        actor: 'verifier'
      })
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it('hydrates snapshot-backed steps from git repos without .hyperagent folder', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opencode-snapshot-root-'))
    try {
      const storageDir = path.join(tmpRoot, 'storage')
      const sessionDir = path.join(storageDir, 'session', 'hash-step-snap-root')
      const messageDir = path.join(storageDir, 'message', 'ses_snaproot')
      const partDir = path.join(storageDir, 'part', 'msg_snaproot')
      await fs.promises.mkdir(sessionDir, { recursive: true })
      await fs.promises.mkdir(messageDir, { recursive: true })
      await fs.promises.mkdir(partDir, { recursive: true })

      const snapshotRoot = path.join(tmpRoot, 'snapshot')
      await fs.promises.mkdir(snapshotRoot, { recursive: true })

      const repoWorktree = path.join(tmpRoot, 'snapshot-worktree')
      await fs.promises.mkdir(repoWorktree, { recursive: true })
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com'
      }
      execFileSync('git', ['init'], { cwd: repoWorktree, env: gitEnv })

      const now = new Date().toISOString()
      const workerLogFile = {
        id: 'ses-worker-root',
        log: [
          {
            entryId: 'root-entry',
            provider: 'opencode',
            model: 'github-copilot/gpt-5-mini',
            createdAt: now,
            payload: { output: 'Root worker output' }
          }
        ],
        createdAt: now,
        updatedAt: now
      }
      await fs.promises.writeFile(path.join(repoWorktree, 'ses-worker-root.json'), JSON.stringify(workerLogFile), 'utf8')
      execFileSync('git', ['add', 'ses-worker-root.json'], { cwd: repoWorktree, env: gitEnv })
      execFileSync('git', ['commit', '-m', 'snapshot data'], { cwd: repoWorktree, env: gitEnv })
      const treeHash = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repoWorktree, env: gitEnv })
        .toString()
        .trim()

      const snapshotRepoDir = path.join(snapshotRoot, 'demo-snapshot')
      await fs.promises.cp(path.join(repoWorktree, '.git'), snapshotRepoDir, { recursive: true })

      const sessionJson = {
        id: 'ses_snaproot',
        directory: '/workspace/snapshot-root-repo',
        title: 'Snapshot Root Session',
        time: { created: now, updated: now },
        summary: { additions: 0, deletions: 0, files: 0 }
      }
      await fs.promises.writeFile(path.join(sessionDir, 'ses_snaproot.json'), JSON.stringify(sessionJson), 'utf8')

      const messageJson = {
        id: 'msg_snaproot',
        sessionID: 'ses_snaproot',
        role: 'assistant',
        time: { created: now, completed: now },
        modelID: 'mock-model',
        providerID: 'opencode'
      }
      await fs.promises.writeFile(path.join(messageDir, 'msg_snaproot.json'), JSON.stringify(messageJson), 'utf8')

      const partJson = {
        id: 'prt_snaproot',
        sessionID: 'ses_snaproot',
        messageID: 'msg_snaproot',
        type: 'step-start',
        text: '',
        snapshot: treeHash,
        time: { start: now, end: now }
      }
      await fs.promises.writeFile(path.join(partDir, 'prt_snaproot.json'), JSON.stringify(partJson), 'utf8')

      const storage = createOpencodeStorage({ rootDir: tmpRoot })
      const detail = await storage.getSession('ses_snaproot')
      expect(detail).not.toBeNull()
      if (!detail) return
      const message = detail.messages.find((m) => m.id === 'msg_snaproot')
      const part = message?.parts.find((p) => p.id === 'prt_snaproot')
      expect(part?.text).toBe('Root worker output')
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it('preserves arbitrary metadata on parts and coerces times to ISO', async () => {
    // Build a temporary opencode layout with a custom metadata fields on a part
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opencode-test-'))
    try {
      const storageRoot = tmpRoot
      const storageDir = path.join(storageRoot, 'storage')
      const sessionDir = path.join(storageDir, 'session', 'hash-test')
      const messageDir = path.join(storageDir, 'message', 'ses_test')
      const partDir = path.join(storageDir, 'part', 'msg_custom')
      await fs.promises.mkdir(sessionDir, { recursive: true })
      await fs.promises.mkdir(messageDir, { recursive: true })
      await fs.promises.mkdir(partDir, { recursive: true })

      const now = Date.now()
      const sessionJson = {
        id: 'ses_test',
        directory: '/workspace/test-repo',
        title: 'Test Session',
        time: { created: now, updated: now },
        summary: { additions: 0, deletions: 0, files: 0 }
      }
      await fs.promises.writeFile(path.join(sessionDir, 'ses_test.json'), JSON.stringify(sessionJson), 'utf8')

      const messageJson = {
        id: 'msg_custom',
        sessionID: 'ses_test',
        role: 'assistant',
        time: { created: now, completed: now },
        modelID: 'mock-model',
        providerID: 'opencode'
      }
      await fs.promises.writeFile(path.join(messageDir, 'msg_custom.json'), JSON.stringify(messageJson), 'utf8')

      const partJson = {
        id: 'prt_custom',
        sessionID: 'ses_test',
        messageID: 'msg_custom',
        type: 'tool',
        text: 'Do something',
        time: { start: now, end: now },
        cost: 0.123,
        tokens: 42,
        extra: { nested: true }
      }
      await fs.promises.writeFile(path.join(partDir, 'prt_custom.json'), JSON.stringify(partJson), 'utf8')

      const storage = createOpencodeStorage({ rootDir: storageRoot })
      const detail = await storage.getSession('ses_test')
      expect(detail).not.toBeNull()
      if (!detail) return

      const msg = detail.messages.find((m) => m.id === 'msg_custom')
      expect(msg).toBeDefined()
      const part = msg?.parts.find((p) => p.id === 'prt_custom')
      expect(part).toBeDefined()
      // arbitrary fields should be preserved on the part object
      // @ts-ignore
      expect((part as any).cost).toBe(0.123)
      // @ts-ignore
      expect((part as any).tokens).toBe(42)
      // nested object preserved
      // @ts-ignore
      expect((part as any).extra && (part as any).extra.nested).toBe(true)
      // times coerced to ISO
      expect(typeof part?.start).toBe('string')
      expect(typeof part?.end).toBe('string')
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true })
    }
  })
})

describe('resolveDefaultOpencodeRoot', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prefers candidate directories that already exist', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.spyOn(os, 'homedir').mockReturnValue('/Users/demo')
    const localShare = path.join('/Users/demo', '.local', 'share', 'opencode')
    vi.spyOn(fs, 'existsSync').mockImplementation((target) => {
      const value = typeof target === 'string' ? target : target.toString()
      return value === localShare
    })
    expect(resolveDefaultOpencodeRoot()).toBe(localShare)
  })

  it('falls back to the first candidate when none exist', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.spyOn(os, 'homedir').mockReturnValue('/home/demo')
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    expect(resolveDefaultOpencodeRoot()).toBe(path.join('/home/demo', '.local', 'share', 'opencode'))
  })
})
