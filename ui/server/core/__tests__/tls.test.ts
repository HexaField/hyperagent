import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveTlsMaterials } from '../tls'

const tmpDirs: string[] = []

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('core/tls resolveTlsMaterials', () => {
  it('uses in-memory certificate data when provided together', async () => {
    const result = await resolveTlsMaterials({ cert: 'CERT', key: 'KEY' })
    expect(result.cert.toString()).toBe('CERT')
    expect(result.key.toString()).toBe('KEY')
  })

  it('reads certificate and key from files when paths are provided', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tls-test-'))
    tmpDirs.push(dir)
    const certPath = path.join(dir, 'cert.pem')
    const keyPath = path.join(dir, 'key.pem')
    await fs.writeFile(certPath, 'CERT-FILE')
    await fs.writeFile(keyPath, 'KEY-FILE')

    const result = await resolveTlsMaterials({ certPath, keyPath })
    expect(result.cert.toString()).toBe('CERT-FILE')
    expect(result.key.toString()).toBe('KEY-FILE')
  })

  it('rejects when certificate/key pairs are incomplete', async () => {
    await expect(resolveTlsMaterials({ cert: 'ONLY' })).rejects.toThrow(/both certificate and key data/i)
    await expect(resolveTlsMaterials({ key: 'ONLY' })).rejects.toThrow(/both certificate and key data/i)
  })
})
