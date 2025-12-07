import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const IMAGE_TAG = 'hyperagent-workflow-runner:latest'

const commandExists = (cmd: string): boolean => spawnSync('which', [cmd]).status === 0

const log = (...args: unknown[]) => console.log('[docker-image.test]', ...args)

const buildRunnerImage = () => {
  log('building image', IMAGE_TAG)
  const result = spawnSync(
    'docker',
    ['build', '-t', IMAGE_TAG, '-f', 'docker/workflow-runner/Dockerfile', '.'],
    {
      stdio: 'inherit',
      timeout: 300_000
    }
  )
  log('build finished', {
    status: result.status,
    signal: result.signal,
    stderr: result.stderr?.slice(-500)
  })
  return result
}

describe('agent runner docker image', () => {
  beforeAll(() => {
    const dockerPresent = commandExists('docker')
    expect(dockerPresent, "Docker CLI 'docker' must be installed to run docker tests").toBe(true)
  })

  afterAll(() => {
    // No cleanup needed; we leave the image cached for faster local runs.
  })

  it('bundles git, opencode, and rad CLIs', () => {
    const buildResult = buildRunnerImage()
    expect(buildResult.status, buildResult.stderr).toBe(0)

    log('checking opencode version')
    const runOpencode = spawnSync(
      'docker',
      ['run', '--rm', '--entrypoint', '/usr/local/bin/opencode', IMAGE_TAG, '--version'],
      { encoding: 'utf8' }
    )
    expect(runOpencode.status, runOpencode.stderr).toBe(0)
    expect(runOpencode.stdout.trim().length).toBeGreaterThan(0)

    log('checking rad version')
    const runRad = spawnSync(
      'docker',
      ['run', '--rm', '--entrypoint', '/usr/local/bin/rad', IMAGE_TAG, '--version'],
      { encoding: 'utf8' }
    )
    expect(runRad.status, runRad.stderr).toBe(0)

    log('checking git version')
    const runGit = spawnSync(
      'docker',
      ['run', '--rm', '--entrypoint', '/usr/bin/git', IMAGE_TAG, '--version'],
      { encoding: 'utf8' }
    )
    expect(runGit.status, runGit.stderr).toBe(0)
  }, 240_000)

  it('executes the agent orchestrator end-to-end with the bundled opencode and rad', () => {
    const buildResult = buildRunnerImage()
    expect(buildResult.status, buildResult.stderr).toBe(0)

    const gitPresent = commandExists('git')
    expect(gitPresent, "git must be installed on the host to prepare a workspace mount").toBe(true)

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-agent-docker-'))
    const workspaceDir = path.join(tmpRoot, 'workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })

    const opencodeConfig = {
      $schema: 'https://opencode.ai/config.json',
      permission: { edit: 'allow', bash: 'allow' }
    }
    fs.writeFileSync(path.join(workspaceDir, 'opencode.json'), JSON.stringify(opencodeConfig, null, 2), 'utf8')

    // Initialize a barebones git repo so rad/git are usable inside the container.
    log('initializing git repo', workspaceDir)
    spawnSync('git', ['init'], { cwd: workspaceDir, stdio: 'inherit' })

    const prompt = 'Return a short JSON object indicating orchestrator-ok: true'
    log('starting container run', { workspaceDir, prompt })
    const runResult = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '-v', `${workspaceDir}:/workspace`,
        '-e', 'AGENT_WORKSPACE_PATH=/workspace',
        '-e', `AGENT_PROMPT=${prompt}`,
        '-e', 'AGENT_MODEL=local/echo',
        '-e', 'OPENCODE_PROMPT_TIMEOUT_MS=5000',
        '-e', 'OPENCODE_LOG_LEVEL=debug',
        '-e', 'NODE_OPTIONS=--max-old-space-size=512',
        IMAGE_TAG
      ],
      {
        encoding: 'utf8',
        stdio: ['inherit', 'pipe', 'pipe'],
        timeout: 240_000
      }
    )

    log('container run finished', {
      status: runResult.status,
      signal: runResult.signal,
      stdoutTail: runResult.stdout?.slice(-1000),
      stderrTail: runResult.stderr?.slice(-1000)
    })

    expect(runResult.status, runResult.stderr).toBe(0)
    expect(runResult.stdout).toContain('agent.run.completed')
  }, 480_000)
})
