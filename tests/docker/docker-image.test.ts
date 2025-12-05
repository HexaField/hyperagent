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

    const output = spawnSync('docker', ['run', '--rm', 'alpine:3.20', '/bin/sh', '-c', 'echo review-runner-ready'], {
      encoding: 'utf8'
    })

    expect(output.status, output.stderr).toBe(0)
    expect(output.stdout.trim()).toBe('review-runner-ready')
  }, 120_000)

  it('bundles git, opencode, and rad CLIs in the workflow runner image', () => {
    const dockerPresent = commandExists('docker')
    expect(dockerPresent, "Docker CLI 'docker' must be installed to run workflow runner tests").toBe(true)

    const buildResult = spawnSync('docker', [
      'build',
      '-t',
      'hyperagent-workflow-runner:latest',
      '-f',
      'tests/docker/workflow-runner.Dockerfile',
      'tests/docker'
    ])
    expect(buildResult.status, buildResult.stderr.toString()).toBe(0)

    const runOpencode = spawnSync('docker', [
      'run',
      '--rm',
      '--entrypoint',
      '/usr/local/bin/opencode',
      'hyperagent-workflow-runner:latest',
      '--version'
    ], { encoding: 'utf8' })
    expect(runOpencode.status, runOpencode.stderr).toBe(0)
    expect(runOpencode.stdout.trim().length).toBeGreaterThan(0)

    const runRad = spawnSync('docker', [
      'run',
      '--rm',
      '--entrypoint',
      '/usr/local/bin/rad',
      'hyperagent-workflow-runner:latest',
      '--version'
    ], { encoding: 'utf8' })
    expect(runRad.status, runRad.stderr).toBe(0)

    const runGit = spawnSync('docker', [
      'run',
      '--rm',
      '--entrypoint',
      '/usr/bin/git',
      'hyperagent-workflow-runner:latest',
      '--version'
    ], { encoding: 'utf8' })
    expect(runGit.status, runGit.stderr).toBe(0)
  }, 240_000)
})
