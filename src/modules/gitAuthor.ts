import { spawnSync } from 'node:child_process'

export type GitAuthor = {
  name: string
  email: string
}

export function detectGitAuthorFromCli(): GitAuthor | null {
  const name = readGitConfigValue('user.name')
  const email = readGitConfigValue('user.email')
  if (name && email) {
    return { name, email }
  }
  return null
}

function readGitConfigValue(key: string): string | null {
  const attempts: string[][] = [
    ['config', '--get', key],
    ['config', '--global', '--get', key],
    ['config', '--system', '--get', key]
  ]
  for (const args of attempts) {
    try {
      const result = spawnSync('git', args, { encoding: 'utf8' })
      if (result.status === 0) {
        const value = result.stdout.trim()
        if (value.length) {
          return value
        }
      }
    } catch {
      // ignore errors when git config scopes are unavailable
    }
  }
  return null
}
