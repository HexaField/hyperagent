import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

function commandExists(cmd: string): boolean {
  const result = spawnSync('which', [cmd])
  return result.status === 0
}

describe('docker runtime smoke test', () => {
  it('runs an alpine container to verify the review runner environment', () => {
    const dockerPresent = commandExists('docker')
    expect(dockerPresent, "Docker CLI 'docker' must be installed to run review tests").toBe(true)

    const output = spawnSync(
      'docker',
      ['run', '--rm', 'alpine:3.20', '/bin/sh', '-c', 'echo review-runner-ready'],
      { encoding: 'utf8' }
    )

    expect(output.status, output.stderr).toBe(0)
    expect(output.stdout.trim()).toBe('review-runner-ready')
  }, 120_000)
})
