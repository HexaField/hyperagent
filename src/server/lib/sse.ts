import type { Request, Response } from 'express'

export type SseStream = {
  emit: (data: unknown, event?: string) => void
  close: () => void
  onClose: (handler: () => void) => () => void
}

export type CreateSseStreamOptions = {
  keepAliveMs?: number
}

export function createSseStream(res: Response, req?: Request, options: CreateSseStreamOptions = {}): SseStream {
  const keepAliveMs = options.keepAliveMs ?? 15000
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  ;(res as Response & { flushHeaders?: () => void }).flushHeaders?.()
  req?.socket?.setKeepAlive?.(true)

  let closed = false
  const closeHandlers = new Set<() => void>()

  const flush = () => {
    const maybeFlush = (res as Response & { flush?: () => void }).flush
    if (typeof maybeFlush === 'function') {
      maybeFlush.call(res)
    }
  }

  const write = (lines: string[]) => {
    if (closed) return
    res.write(`${lines.join('\n')}\n\n`)
    flush()
  }

  const emit = (data: unknown, event?: string) => {
    const payload = typeof data === 'string' ? data : JSON.stringify(data)
    const lines = []
    if (event) {
      lines.push(`event: ${event}`)
    }
    lines.push(`data: ${payload}`)
    write(lines)
  }

  const close = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    closeHandlers.forEach((handler) => {
      try {
        handler()
      } catch {
        // ignore cleanup errors
      }
    })
    closeHandlers.clear()
    try {
      res.end()
    } catch {
      // ignore end failures
    }
  }

  const onClose = (handler: () => void) => {
    if (closed) {
      handler()
      return () => undefined
    }
    closeHandlers.add(handler)
    return () => closeHandlers.delete(handler)
  }

  const heartbeat = setInterval(() => {
    if (closed) return
    res.write(': heartbeat\n\n')
    flush()
  }, keepAliveMs)

  const connectionCloseHandler = () => close()
  res.on('close', connectionCloseHandler)
  res.on('error', connectionCloseHandler)

  closeHandlers.add(() => {
    res.off('close', connectionCloseHandler)
    res.off('error', connectionCloseHandler)
  })

  return { emit, close, onClose }
}
