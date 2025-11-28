import { EventEmitter } from 'events'
import fs from 'fs/promises'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn as realSpawn } from 'node:child_process'
import os from 'os'
import path from 'path'
import { PassThrough } from 'stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpencodeRunner, DEFAULT_OPENCODE_MODEL } from './provider'

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdio: [PassThrough, PassThrough, PassThrough, null, null] = [this.stdin, this.stdout, this.stderr, null, null]
  pid = Math.floor(Math.random() * 10000) + 1000
  connected = true
  killed = false
  spawnfile = 'opencode'
  spawnargs: string[] = []
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  ref = vi.fn()
  unref = vi.fn()
  kill = vi.fn()
  disconnect = vi.fn()
  send = vi.fn(() => false)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createOpencodeRunner', () => {
  it('persists run metadata once session id is emitted', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-runner-ws-'))
    const metadataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-runner-meta-'))
    const child = new FakeChild()
    const spawnMock = vi.fn((..._args: any[]) => child as unknown as ChildProcessWithoutNullStreams).mockName('spawn')
    const spawnFn = spawnMock as unknown as typeof realSpawn

    const runner = createOpencodeRunner({ metadataDir, logsDir: path.join(metadataDir, 'logs'), spawnFn })
    const startPromise = runner.startRun({ workspacePath: workspace, prompt: 'Run tests' })

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    const call = spawnMock.mock.calls[0]
    expect(call?.[0]).toBe('opencode')
    expect(call?.[1]).toEqual(expect.arrayContaining(['--model', DEFAULT_OPENCODE_MODEL]))
    expect(call?.[2]).toMatchObject({ cwd: workspace })

    child.stdout.emit('data', Buffer.from('{"sessionID":"ses_test"}'))
    child.emit('exit', 0, null)

    const record = await startPromise
    expect(record.sessionId).toBe('ses_test')
    expect(record.status).toBe('running')
    expect(record.model).toBe(DEFAULT_OPENCODE_MODEL)

    const runs = await runner.listRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0].sessionId).toBe('ses_test')
  })

  it('marks runs as terminated when killRun is invoked', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-runner-ws-'))
    const metadataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-runner-meta-'))
    const child = new FakeChild()
    const spawnMock = vi.fn((..._args: any[]) => child as unknown as ChildProcessWithoutNullStreams).mockName('spawn')
    const spawnFn = spawnMock as unknown as typeof realSpawn
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => undefined as any)

    const runner = createOpencodeRunner({ metadataDir, logsDir: path.join(metadataDir, 'logs'), spawnFn })
    const startPromise = runner.startRun({ workspacePath: workspace, prompt: 'Refactor' })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    const call = spawnMock.mock.calls[0]
    expect(call?.[1]).toEqual(expect.arrayContaining(['--model', DEFAULT_OPENCODE_MODEL]))
    child.stdout.emit('data', Buffer.from('{"sessionID":"ses_kill"}'))
    await startPromise

    const result = await runner.killRun('ses_kill')
    expect(result).toBe(true)
    expect(killSpy).toHaveBeenCalled()
    child.emit('exit', 0, null)
    const runs = await runner.listRuns()
    expect(runs[0].status).toBe('terminated')
  })
})
