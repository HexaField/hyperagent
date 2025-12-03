import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export const META_FOLDER = '.hyperagent'
export const DEFAULT_MODEL_MAX_CTX = 128000

export function sanitizeSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return safe.length ? safe : 'session'
}

export function resolveSessionRoot(sessionId: string, baseDir?: string): string {
  return baseDir ? path.join(baseDir) : path.join(os.tmpdir(), '.sessions', sessionId)
}

export function metaDirectory(sessionId: string, baseDir?: string): string {
  const root = resolveSessionRoot(sessionId, baseDir)
  const dir = path.join(root, META_FOLDER)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function metaFile(sessionId: string, baseDir?: string) {
  const dir = metaDirectory(sessionId, baseDir)
  return path.join(dir, `${sanitizeSessionId(sessionId)}.json`)
}

export type LogEntry = {
  entryId: string
  provider: string
  model?: string
  role?: string
  payload: any
  createdAt: string
}

export type SessionMeta = {
  id: string
  log: LogEntry[]
  createdAt: string
  updatedAt: string
}

export function loadSessionMeta(sessionId: string, baseDir?: string): SessionMeta {
  const file = metaFile(sessionId, baseDir)
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, 'utf-8')
      const parsed = JSON.parse(raw)
      parsed.log = Array.isArray(parsed.log) ? parsed.log : []
      return parsed
    } catch (e) {
      console.log('Failed to parse session meta json; recreating', e)
    }
  }
  const blank: SessionMeta = {
    id: sessionId,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  saveSessionMeta(blank, baseDir)
  return blank
}

export function saveSessionMeta(meta: SessionMeta, baseDir?: string) {
  const file = metaFile(meta.id, baseDir)
  meta.updatedAt = new Date().toISOString()
  fs.writeFileSync(file, JSON.stringify(meta, null, 2))
}

export type LogEntryInit = {
  provider: string
  model?: string
  role?: string
  payload: any
  entryId?: string
  createdAt?: string
}

export function appendLogEntry(meta: SessionMeta, entry: LogEntryInit, baseDir?: string) {
  const normalized: LogEntry = {
    entryId: entry.entryId || `${entry.provider}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    provider: entry.provider,
    model: entry.model,
    role: entry.role,
    payload: entry.payload,
    createdAt: entry.createdAt || new Date().toISOString()
  }
  meta.log = Array.isArray(meta.log) ? meta.log : []
  meta.log.push(normalized)
  saveSessionMeta(meta, baseDir)
}

export function findLatestLogEntry(meta: SessionMeta, predicate: (entry: LogEntry) => boolean): LogEntry | undefined {
  const log = Array.isArray(meta.log) ? meta.log : []
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]
    if (predicate(entry)) return entry
  }
  return undefined
}

export type CLIStreamHooks = {
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export async function runCLI(
  command: string,
  args: string[],
  input: string,
  sessionDir?: string,
  hooks?: CLIStreamHooks
): Promise<string> {
  const workingDir = sessionDir || path.join(os.tmpdir(), 'hyperagent-cli')
  if (!fs.existsSync(workingDir)) {
    fs.mkdirSync(workingDir, { recursive: true })
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workingDir
    })
    let out = ''
    let err = ''

    child.stdout.on('data', (chunk) => {
      const text = String(chunk)
      console.log(text)
      out += text
      try {
        hooks?.onStdout?.(text)
      } catch (err) {
        console.warn('runCLI stdout hook failed', err)
      }
    })
    child.stderr.on('data', (chunk) => {
      const text = String(chunk)
      console.log(text)
      err += text
      try {
        hooks?.onStderr?.(text)
      } catch (errHook) {
        console.warn('runCLI stderr hook failed', errHook)
      }
    })

    child.on('error', (e) => reject(e))
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`CLI exited ${code}: ${err}`))
      }
      resolve(out)
    })

    if (input) {
      child.stdin.write(input)
    }
    child.stdin.end()
  })
}

export function extractOrCreateJSON(fullMessage: string): any {
  try {
    return JSON.parse(fullMessage)
  } catch {
    const allMatches = Array.from(fullMessage.matchAll(/(\{[\s\S]*?\})/g)).map((r) => r[1])
    for (const jsonText of allMatches) {
      try {
        const parsed = JSON.parse(jsonText)
        if (parsed && typeof parsed === 'object') {
          if ('answer' in parsed && 'status' in parsed) return parsed
          for (const key of ['text', 'message', 'content']) {
            if (typeof (parsed as any)[key] === 'string') {
              const inner = (parsed as any)[key]
              try {
                const innerParsed = JSON.parse(inner)
                if (
                  innerParsed &&
                  typeof innerParsed === 'object' &&
                  'answer' in innerParsed &&
                  'status' in innerParsed
                ) {
                  return innerParsed
                }
              } catch {}
            }
          }
          if (Object.keys(parsed).length > 0) return parsed
        }
      } catch {}
    }
    return { text: fullMessage }
  }
}

export function outClean(s: string): string {
  return typeof s === 'string' ? s.trim() : s
}
