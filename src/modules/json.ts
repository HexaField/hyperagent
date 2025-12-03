export function safeParseJson<T = unknown>(raw: string | null | undefined): T | null {
  if (typeof raw !== 'string') {
    return null
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function safeParseObject<T extends Record<string, unknown> = Record<string, unknown>>(
  raw: string | null | undefined
): T | null {
  const parsed = safeParseJson<T>(raw)
  return isPlainObject(parsed) ? (parsed as T) : null
}
