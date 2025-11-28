import { spawn } from 'child_process'
import os from 'os'
import path from 'path'
import type { OpencodeCommandRunner } from './opencodeCommandRunner'

export type ProviderInvocation = { cliArgs?: string[]; payload?: unknown }

export async function runProviderInvocation(
  invocation: ProviderInvocation,
  opts: { cwd?: string; opencodeCommandRunner: OpencodeCommandRunner }
): Promise<any> {
  if (!invocation) throw new Error('No invocation provided')
  if (Array.isArray(invocation.cliArgs) && invocation.cliArgs.length) {
    const res = await opts.opencodeCommandRunner(invocation.cliArgs, { cwd: opts.cwd })
    return res
  }
  // If payload looks like an HTTP invocation, attempt to POST it.
  const payload = invocation.payload
  if (payload && typeof payload === 'object') {
    const asAny = payload as any
    const url = typeof asAny.url === 'string' ? asAny.url : null
    const method = typeof asAny.method === 'string' ? asAny.method.toUpperCase() : 'POST'
    const headers =
      asAny.headers && typeof asAny.headers === 'object' ? asAny.headers : { 'content-type': 'application/json' }
    const body = asAny.body ?? asAny.payload ?? null
    if (!url) throw new Error('Provider payload missing url for HTTP invocation')
    const fetchOptions: any = { method, headers }
    if (body !== null) {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body)
    }
    const resp = await fetch(url, fetchOptions)
    const text = await resp.text().catch(() => '')
    if (!resp.ok) {
      throw new Error(`Provider HTTP invocation failed: ${resp.status} ${resp.statusText} ${text}`)
    }
    return { responseText: text, status: resp.status }
  }
  throw new Error('Unsupported provider invocation: neither cliArgs nor HTTP payload provided')
}

export async function* runProviderInvocationStream(
  invocation: ProviderInvocation,
  opts: { cwd?: string; opencodeCommandRunner: OpencodeCommandRunner; signal?: AbortSignal }
): AsyncGenerator<string, any, void> {
  if (!invocation) throw new Error('No invocation provided')
  // CLI streaming: spawn opencode with args and stream stdout chunks
  if (Array.isArray(invocation.cliArgs) && invocation.cliArgs.length) {
    // If an opencodeCommandRunner wrapper is provided, prefer using it (may not stream).
    if (opts.opencodeCommandRunner) {
      const res = await opts.opencodeCommandRunner(invocation.cliArgs, { cwd: opts.cwd })
      const out = (() => {
        if (!res || typeof res !== 'object') return ''
        if ('stdout' in res && typeof res.stdout === 'string') return res.stdout
        if ('responseText' in (res as Record<string, unknown>)) {
          const text = (res as Record<string, unknown>).responseText
          return typeof text === 'string' ? text : ''
        }
        return ''
      })()
      if (out) yield out
      return
    }
    const spawnCwd = opts.cwd || path.join(os.tmpdir(), 'hyperagent-cli')
    const child = spawn('opencode', invocation.cliArgs, { cwd: spawnCwd })
    let finished = false
    const signal = opts.signal
    if (signal) {
      if (signal.aborted) {
        child.kill('SIGTERM')
        throw new Error('Invocation aborted')
      }
      const onAbort = () => {
        child.kill('SIGTERM')
      }
      signal.addEventListener('abort', onAbort)
      child.on('exit', () => signal.removeEventListener('abort', onAbort))
    }
    try {
      for await (const chunk of child.stdout) {
        const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
        yield text
      }
      finished = true
      const exit = await new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? 0)))
      if (exit !== 0) {
        let stderr = ''
        try {
          for await (const c of child.stderr) {
            stderr += typeof c === 'string' ? c : Buffer.isBuffer(c) ? c.toString('utf8') : String(c)
          }
        } catch {}
        throw new Error(stderr || `CLI exited with ${exit}`)
      }
      return
    } finally {
      if (!finished) {
        try {
          child.kill('SIGTERM')
        } catch {}
      }
    }
  }

  // HTTP streaming: fetch and stream body chunks if possible
  const payload = invocation.payload
  if (payload && typeof payload === 'object') {
    const asAny = payload as any
    const url = typeof asAny.url === 'string' ? asAny.url : null
    const method = typeof asAny.method === 'string' ? asAny.method.toUpperCase() : 'POST'
    const headers =
      asAny.headers && typeof asAny.headers === 'object' ? asAny.headers : { 'content-type': 'application/json' }
    const body = asAny.body ?? asAny.payload ?? null
    if (!url) throw new Error('Provider payload missing url for HTTP invocation')
    const controller = new AbortController()
    const signal = opts.signal
    if (signal) {
      if (signal.aborted) controller.abort()
      const onAbort = () => controller.abort()
      signal.addEventListener('abort', onAbort)
      // cleanup later
      signal.addEventListener('abort', () => signal.removeEventListener('abort', onAbort))
    }
    const fetchOptions: any = { method, headers, signal: controller.signal }
    if (body !== null) fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body)
    const resp = await fetch(url, fetchOptions)
    if (!resp.body) {
      const text = await resp.text().catch(() => '')
      yield text
      return
    }
    const reader = resp.body.getReader()
    const decoder = new TextDecoder('utf-8')
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      yield decoder.decode(value, { stream: true })
    }
    return
  }
  throw new Error('Unsupported provider invocation: neither cliArgs nor HTTP payload provided')
}

export default { runProviderInvocation }
