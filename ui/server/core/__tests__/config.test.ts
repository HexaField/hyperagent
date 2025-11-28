import { describe, expect, it } from 'vitest'
import { buildExternalUrl, mergeFrameAncestorsDirective, normalizePublicOrigin } from '../config'

describe('core/config utilities', () => {
  it('normalizes public origins and rejects invalid input', () => {
    expect(normalizePublicOrigin('example.com')).toBe('https://example.com')
    expect(normalizePublicOrigin('https://foo.test')).toBe('https://foo.test')
    expect(normalizePublicOrigin('')).toBeNull()
    expect(normalizePublicOrigin('not a url')).toBeNull()
  })

  it('builds external URLs relative to an origin', () => {
    expect(buildExternalUrl('/hello', 'https://foo.test')).toBe('https://foo.test/hello')
    expect(buildExternalUrl('https://bar.test/path', 'https://foo.test')).toBe('https://bar.test/path')
    expect(buildExternalUrl(null, 'https://foo.test')).toBeNull()
  })

  it('merges frame-ancestors directives without duplicating entries', () => {
    const policy = "default-src 'self'; frame-ancestors 'self' https://old.test"
    const merged = mergeFrameAncestorsDirective(policy, 'https://new.test')
    expect(merged).toBe("default-src 'self'; frame-ancestors 'self' https://new.test")
  })
})
