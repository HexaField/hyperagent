import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { applyTheme, setTheme, getStoredTheme } from './theme'

function mockMatchMedia(matches = false) {
  const listeners: any[] = []
  const mql = {
    matches,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (ev: string, cb: any) => listeners.push(cb),
    removeEventListener: (ev: string, cb: any) => {},
    addListener: (cb: any) => listeners.push(cb),
    removeListener: (cb: any) => {},
    // helper to simulate change
    _emit: (val: boolean) => {
      mql.matches = val
      listeners.forEach((cb) => cb({ matches: val }))
    }
  }
  // @ts-ignore
  window.matchMedia = () => mql
  return mql
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
})

afterEach(() => {
  document.documentElement.classList.remove('dark')
})

describe('theme utilities', () => {
  it('applies dark theme when set', () => {
    applyTheme('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('applies light theme when set', () => {
    document.documentElement.classList.add('dark')
    applyTheme('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('system theme follows matchMedia and reacts to changes', () => {
    const mql = mockMatchMedia(false)
    const cleanup = applyTheme('system')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    mql._emit(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    cleanup && cleanup()
  })

  it('stores theme in localStorage when setTheme is called', () => {
    setTheme('dark')
    expect(localStorage.getItem('theme')).toBe('dark')
    expect(getStoredTheme()).toBe('dark')
  })
})
