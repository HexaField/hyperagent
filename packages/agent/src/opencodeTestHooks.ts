import { spawnSync } from 'child_process'
import { afterAll, beforeAll } from 'vitest'
import { getOpencodeServer } from './opencode'

export const opencodeTestHooks = () => {
  beforeAll(() => {
    try {
      const res = spawnSync('lsof', ['-tiTCP:4096', '-sTCP:LISTEN'])
      if (res.status === 0 && res.stdout) {
        const out = res.stdout.toString().trim()
        if (out) {
          const pids = out.split(/\s+/)
          for (const pid of pids) {
            try {
              spawnSync('kill', ['-9', pid])
            } catch {}
          }
        }
      }
    } catch {}
  })
  afterAll(async () => {
    const server = await getOpencodeServer()
    server.close()
  })
}
