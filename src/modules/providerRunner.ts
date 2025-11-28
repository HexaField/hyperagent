import type { OpencodeCommandRunner, OpencodeCommandOptions } from '../ui/server/app'

export type ProviderInvocation = { cliArgs?: string[]; payload?: unknown }

export async function runProviderInvocation(
  invocation: ProviderInvocation,
  opts: { cwd?: string; opencodeCommandRunner: OpencodeCommandRunner }
): Promise<void> {
  if (!invocation) throw new Error('No invocation provided')
  if (Array.isArray(invocation.cliArgs) && invocation.cliArgs.length) {
    await opts.opencodeCommandRunner(invocation.cliArgs, { cwd: opts.cwd })
    return
  }
  // If payload looks like an HTTP invocation, attempt to POST it.
  const payload = invocation.payload
  if (payload && typeof payload === 'object') {
    const asAny = payload as any
    const url = typeof asAny.url === 'string' ? asAny.url : null
    const method = typeof asAny.method === 'string' ? asAny.method.toUpperCase() : 'POST'
    const headers = (asAny.headers && typeof asAny.headers === 'object') ? asAny.headers : { 'content-type': 'application/json' }
    const body = asAny.body ?? asAny.payload ?? null
    if (!url) throw new Error('Provider payload missing url for HTTP invocation')
    const fetchOptions: any = { method, headers }
    if (body !== null) {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body)
    }
    const resp = await fetch(url, fetchOptions)
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Provider HTTP invocation failed: ${resp.status} ${resp.statusText} ${text}`)
    }
    return
  }
  throw new Error('Unsupported provider invocation: neither cliArgs nor HTTP payload provided')
}

export default { runProviderInvocation }
