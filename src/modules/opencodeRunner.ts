import fsSync from 'fs'
import fs from 'fs/promises'
import {
  spawn as spawnProcess,
  spawnSync as spawnProcessSync,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from 'node:child_process'
import os from 'os'
import path from 'path'

export const DEFAULT_OPENCODE_MODEL = 'github-copilot/gpt-5-mini'
export const DEFAULT_OPENCODE_PROVIDER = 'opencode'

export type OpencodeRunStatus = 'starting' | 'running' | 'exited' | 'failed' | 'terminated'

export type OpencodeRunRecord = {
  sessionId: string
  pid: number
  workspacePath: string
  prompt: string
  title: string | null
  model: string | null
  providerId: string | null
  logFile: string
  startedAt: string
  updatedAt: string
  status: OpencodeRunStatus
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export type StartRunInput = {
  workspacePath: string
  prompt: string
  title?: string | null
  model?: string | null
  providerId?: string | null
}

export type OpencodeRunner = {
  startRun: (input: StartRunInput) => Promise<OpencodeRunRecord>
  listRuns: () => Promise<OpencodeRunRecord[]>
  getRun: (sessionId: string) => Promise<OpencodeRunRecord | null>
  killRun: (sessionId: string) => Promise<boolean>
}

type RunnerOptions = {
  metadataDir?: string
  logsDir?: string
  spawnOptions?: Partial<SpawnOptionsWithoutStdio>
  spawnFn?: typeof spawnProcess
}

type RunFile = OpencodeRunRecord

type JsonAccumulator = (chunk: string) => void

export function createOpencodeRunner(options: RunnerOptions = {}): OpencodeRunner {
  const metadataDir = options.metadataDir ?? path.join(os.homedir(), '.hyperagent', 'opencode-runs')
  const logsDir = options.logsDir ?? path.join(metadataDir, 'logs')
  const spawnFn = options.spawnFn ?? spawnProcess
  let reconciled = false
  const runCache: Map<string, RunFile> = new Map()

  const ensureReady = async () => {
    if (!reconciled) {
      await fs.mkdir(metadataDir, { recursive: true })
      await fs.mkdir(logsDir, { recursive: true })
      await reconcileRuns()
      reconciled = true
    }
  }

  const startRun = async (input: StartRunInput): Promise<OpencodeRunRecord> => {
    await ensureReady()
    await assertWorkspaceExists(input.workspacePath)
    const resolvedModel = resolveModel(input.model)
    const resolvedProvider = resolveProvider(input.providerId)
    // Resolve opencode binary path. Allow overriding with OPENCODE_BIN env var.
    let opencodeCmd = process.env.OPENCODE_BIN ?? 'opencode'
    let resolvedOpencodePath = ''
    try {
      if (process.env.OPENCODE_BIN) {
        resolvedOpencodePath = process.env.OPENCODE_BIN
      } else {
        const whichResult = spawnProcessSync('which', [opencodeCmd])
        if (whichResult.status === 0 && whichResult.stdout) {
          resolvedOpencodePath = String(whichResult.stdout).trim()
        }
      }
    } catch {
      resolvedOpencodePath = ''
    }
    if (!resolvedOpencodePath) {
      throw new Error('Missing `opencode` CLI on PATH. Install the opencode binary or set OPENCODE_BIN to its path.')
    }
    // Log chosen binary for easier troubleshooting
    console.log('[opencode-runner] Using opencode binary:', resolvedOpencodePath)
    const env = { ...process.env }
    const args = buildRunArgs({ ...input, model: resolvedModel })
    console.log('[opencode-runner] spawn args:', args)
    const child = spawnFn(resolvedOpencodePath, args, {
      cwd: input.workspacePath,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      ...options.spawnOptions
    }) as ChildProcessWithoutNullStreams

    const startedAt = new Date().toISOString()
    const logFile = path.join(logsDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`)
    const logStream = fsSync.createWriteStream(logFile, { flags: 'a' })

    return await new Promise<OpencodeRunRecord>((resolve, reject) => {
      let sessionId: string | null = null
      let settled = false

      const succeed = (record: OpencodeRunRecord) => {
        if (settled) return
        settled = true
        resolve(record)
      }

      const fail = (error: Error) => {
        if (settled) return
        settled = true
        reject(error)
      }

      const parser = createJsonAccumulator((event) => {
        if (!sessionId && typeof event.sessionID === 'string') {
          const ensuredId = event.sessionID as string
          sessionId = ensuredId
          const record: OpencodeRunRecord = {
            sessionId: ensuredId,
            pid: child.pid ?? -1,
            workspacePath: input.workspacePath,
            prompt: input.prompt,
            title: input.title?.trim() || null,
            model: resolvedModel,
            providerId: resolvedProvider,
            logFile,
            startedAt,
            updatedAt: startedAt,
            status: 'running',
            exitCode: null,
            signal: null
          }
          void (async () => {
            try {
              await writeRun(record)
              // cache the run immediately so listRuns can observe it
              runCache.set(ensuredId, record)
              child.unref()
              succeed(record)
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)))
            }
          })()
        }
      })

      let sawStdout = false
      let sawStderr = false
      child.stdout.on('data', (chunk) => {
        try {
          const asStr = chunk.toString()
          logStream.write(chunk)
          parser(asStr)
          if (!sawStdout) {
            sawStdout = true
            console.log('[opencode-runner] child stdout (first chunk):', asStr.slice(0, 200))
          }
        } catch (err) {
          logStream.write(`\n[stdout parse error: ${String(err)}]\n`)
        }
      })
      child.stderr.on('data', (chunk) => {
        try {
          const asStr = chunk.toString()
          logStream.write(chunk)
          if (!sawStderr) {
            sawStderr = true
            console.error('[opencode-runner] child stderr (first chunk):', asStr.slice(0, 200))
          }
        } catch (err) {
          logStream.write(`\n[stderr parse error: ${String(err)}]\n`)
        }
      })
      child.on('error', (error) => {
        logStream.end(`\n[process error: ${error instanceof Error ? error.message : String(error)}]\n`)
        fail(error instanceof Error ? error : new Error(String(error)))
      })
      child.on('exit', async (code, signal) => {
        logStream.end(`\n[process exited with code ${code ?? 'null'}]\n`)
        if (sessionId) {
          const status: OpencodeRunStatus = code === 0 ? 'exited' : 'failed'
          await updateRun(sessionId, {
            status,
            exitCode: code ?? null,
            signal: signal ?? null,
            updatedAt: new Date().toISOString()
          })
          // update cache copy
          const cached = runCache.get(sessionId)
          if (cached) {
            runCache.set(sessionId, {
              ...cached,
              status,
              exitCode: code ?? null,
              signal: signal ?? null,
              updatedAt: new Date().toISOString()
            })
          }
          if (!settled) {
            settled = true
            const persisted = await readRun(sessionId)
            const ensuredId = sessionId as string
            resolve(
              persisted ?? {
                sessionId: ensuredId,
                pid: child.pid ?? -1,
                workspacePath: input.workspacePath,
                prompt: input.prompt,
                title: input.title?.trim() || null,
                model: resolvedModel,
                providerId: resolvedProvider,
                logFile,
                startedAt,
                updatedAt: new Date().toISOString(),
                status,
                exitCode: code ?? null,
                signal: signal ?? null
              }
            )
          }
          return
        }

        fail(new Error('Opencode run exited before emitting a session id'))
      })
    })
  }

  const listRuns = async (): Promise<OpencodeRunRecord[]> => {
    await ensureReady()
    // prefer cached runs first, then read files to include persisted ones
    const fileRuns = await readAllRuns()
    const cached = Array.from(runCache.values())
    const merged = new Map<string, RunFile>()
    for (const r of fileRuns) merged.set(r.sessionId, r)
    for (const r of cached) merged.set(r.sessionId, r)
    return Array.from(merged.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  const getRun = async (sessionId: string): Promise<OpencodeRunRecord | null> => {
    await ensureReady()
    return await readRun(sessionId)
  }

  const killRun = async (sessionId: string): Promise<boolean> => {
    await ensureReady()
    const record = await readRun(sessionId)
    if (!record) return false
    try {
      await terminateProcess(record.pid)
      await updateRun(sessionId, {
        status: 'terminated',
        updatedAt: new Date().toISOString(),
        exitCode: null,
        signal: 'SIGTERM'
      })
      return true
    } catch (error: any) {
      if (error?.code === 'ESRCH') {
        await updateRun(sessionId, {
          status: 'terminated',
          updatedAt: new Date().toISOString()
        })
        return true
      }
      throw error
    }
  }

  async function reconcileRuns() {
    const runs = await readAllRuns()
    await Promise.all(
      runs.map(async (run) => {
        if (run.status !== 'running') return
        const alive = await isPidAlive(run.pid)
        if (!alive) {
          await updateRun(run.sessionId, {
            status: 'failed',
            updatedAt: new Date().toISOString(),
            exitCode: run.exitCode ?? null,
            signal: run.signal
          })
        }
      })
    )
  }

  function buildRunArgs(input: StartRunInput): string[] {
    const args = ['run', input.prompt, '--format', 'json']
    if (input.title?.trim()) {
      args.push('--title', input.title.trim())
    }
    const model = resolveModel(input.model)
    if (model) {
      args.push('--model', model)
    }
    return args
  }

  function resolveModel(candidate?: string | null): string {
    if (typeof candidate !== 'string') {
      return DEFAULT_OPENCODE_MODEL
    }
    const trimmed = candidate.trim()
    return trimmed.length ? trimmed : DEFAULT_OPENCODE_MODEL
  }

  function resolveProvider(candidate?: string | null): string {
    if (typeof candidate !== 'string') {
      return DEFAULT_OPENCODE_PROVIDER
    }
    const trimmed = candidate.trim()
    return trimmed.length ? trimmed : DEFAULT_OPENCODE_PROVIDER
  }

  function createJsonAccumulator(onObject: (event: any) => void): JsonAccumulator {
    let buffer = ''
    let depth = 0
    let capturing = false
    return (chunk: string) => {
      for (const char of chunk) {
        if (!capturing) {
          if (char === '{') {
            capturing = true
            depth = 1
            buffer = '{'
          }
          continue
        }
        buffer += char
        if (char === '{') {
          depth++
        } else if (char === '}') {
          depth--
          if (depth === 0) {
            try {
              const parsed = JSON.parse(buffer)
              onObject(parsed)
            } catch {
              // ignore malformed fragments
            } finally {
              buffer = ''
              capturing = false
            }
          }
        }
      }
    }
  }

  async function writeRun(record: RunFile): Promise<void> {
    const filePath = runFilePath(record.sessionId)
    const payload = JSON.stringify(record, null, 2)
    await fs.writeFile(filePath, payload, 'utf-8')
    runCache.set(record.sessionId, record)
  }

  async function updateRun(sessionId: string, patch: Partial<RunFile>): Promise<void> {
    const existing = await readRun(sessionId)
    if (!existing) return
    const updated: RunFile = {
      ...existing,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    }
    await writeRun(updated)
    runCache.set(sessionId, updated)
  }

  async function readAllRuns(): Promise<RunFile[]> {
    const entries = await fs.readdir(metadataDir, { withFileTypes: true })
    const list: RunFile[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const filePath = path.join(metadataDir, entry.name)
      try {
        const raw = await fs.readFile(filePath, 'utf-8')
        list.push(JSON.parse(raw) as RunFile)
      } catch {
        // skip malformed files
      }
    }
    list.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    return list
  }

  async function readRun(sessionId: string): Promise<RunFile | null> {
    const filePath = runFilePath(sessionId)
    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      return JSON.parse(raw) as RunFile
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  function runFilePath(sessionId: string): string {
    return path.join(metadataDir, `${sanitizeSessionId(sessionId)}.json`)
  }

  async function assertWorkspaceExists(dirPath: string): Promise<void> {
    const stats = await fs.stat(dirPath)
    if (!stats.isDirectory()) {
      throw new Error(`Workspace path ${dirPath} is not a directory`)
    }
  }

  async function terminateProcess(pid: number): Promise<void> {
    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        const killer = spawnProcess('taskkill', ['/PID', String(pid), '/T', '/F'])
        killer.once('exit', () => resolve())
        killer.once('error', (error) => reject(error))
      })
      return
    }
    try {
      process.kill(-pid, 'SIGTERM')
    } catch (error: any) {
      if (error?.code === 'ESRCH') {
        process.kill(pid, 'SIGTERM')
        return
      }
      if (error?.code !== 'EPERM') throw error
      process.kill(pid, 'SIGTERM')
    }
  }

  async function isPidAlive(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0)
      return true
    } catch (error: any) {
      return error?.code !== 'ESRCH'
    }
  }

  return {
    startRun,
    listRuns,
    getRun,
    killRun
  }
}

function sanitizeSessionId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}
