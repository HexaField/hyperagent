export async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  try {
    const response = await fetch(input, init)
    if (!response.ok) {
      let error = await response.json()
      error = 'error' in error ? error.error : error
      throw new Error(error || 'Request failed')
    }
    return (await response.json()) as T
  } catch (e) {
    console.error(e)
    throw e
  }
}
