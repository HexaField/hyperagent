type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

const getConsoleWriter = (level: LogLevel): ((message?: any) => void) => {
  const method = console[level] as ((message?: any) => void) | undefined
  if (typeof method === 'function') {
    return method.bind(console)
  }
  return console.log.bind(console)
}

const parseLogLevel = (raw?: string | null): LogLevel => {
  if (!raw) return 'info'
  const normalized = raw.toLowerCase()
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized
  }
  return 'info'
}

const getLevelThreshold = (): number => {
  const envLevel = parseLogLevel(process.env.UI_LOG_LEVEL)
  return LEVEL_RANK[envLevel]
}

const serializeForJson = () => {
  const seen = new WeakSet<object>()
  return (_key: string, value: unknown) => {
    if (value instanceof Error) {
      return {
        message: value.message,
        stack: value.stack
      }
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]'
      }
      seen.add(value)
    }
    return value
  }
}

const safeStringify = (payload: LogPayload): string => {
  try {
    return JSON.stringify(payload, serializeForJson())
  } catch {
    return JSON.stringify({
      ts: payload.ts,
      level: payload.level,
      module: payload.module,
      message: payload.message
    })
  }
}

const mergeMeta = (base?: LogMeta, extra?: LogMeta): LogMeta | undefined => {
  if (!base && !extra) return undefined
  if (!base) return { ...extra }
  if (!extra) return { ...base }
  return { ...base, ...extra }
}

export type LogMeta = Record<string, unknown>

export type Logger = {
  debug: (message: string, meta?: LogMeta) => void
  info: (message: string, meta?: LogMeta) => void
  warn: (message: string, meta?: LogMeta) => void
  error: (message: string, meta?: LogMeta) => void
  child: (meta: LogMeta) => Logger
}

export type LogPayload = {
  ts: string
  level: LogLevel
  module: string
  message: string
  meta?: LogMeta
}

export const toErrorMeta = (error: unknown): LogMeta => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null
    }
  }
  return { value: typeof error === 'string' ? error : JSON.stringify(error, serializeForJson()) }
}

export const createLogger = (moduleName: string, defaultMeta?: LogMeta): Logger => {
  const emit = (level: LogLevel, message: string, meta?: LogMeta) => {
    if (LEVEL_RANK[level] < getLevelThreshold()) {
      return
    }
    const mergedMeta = mergeMeta(defaultMeta, meta)
    const payload: LogPayload = {
      ts: new Date().toISOString(),
      level,
      module: moduleName,
      message,
      ...(mergedMeta ? { meta: mergedMeta } : {})
    }
    const writer = getConsoleWriter(level)
    writer(safeStringify(payload))
  }

  const logger: Logger = {
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
    child: (meta) => createLogger(moduleName, mergeMeta(defaultMeta, meta))
  }

  return logger
}
