import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import pacote from 'pacote'
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'

import {
  ClassContract,
  FunctionContract,
  SchemaDescriptor,
  ZodRecipe,
  generatePackageContracts,
  installDependencies,
  invokeLibraryContract,
  uninstallDependencies
} from './npm'

vi.mock('pacote', () => {
  return {
    default: {
      manifest: vi.fn(),
      extract: vi.fn()
    }
  }
})

vi.mock('child_process', () => {
  return {
    spawn: vi.fn(() => {
      const proc = new EventEmitter() as unknown as ChildProcess
      const stdout = new EventEmitter()
      const stderr = new EventEmitter()
      ;(proc as any).stdout = stdout
      ;(proc as any).stderr = stderr
      queueMicrotask(() => proc.emit('close', 0))
      return proc
    })
  }
})

const fsp = fs.promises

const mockedPacote = vi.mocked(pacote)
const mockedSpawn = vi.mocked(spawn)

describe('generatePackageContracts', () => {
  let fixtureDir: string

  beforeEach(async () => {
    fixtureDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'npm-fixture-'))
    await fsp.writeFile(
      path.join(fixtureDir, 'index.ts'),
      `export interface GreeterOptions {\n  name: string\n  excited?: boolean\n}\n\nexport type ResultInfo =\n  | { kind: 'success'; payload: GreeterOptions }\n  | { kind: 'failure'; message: string }\n\nexport async function fetchProfile(name: string): Promise<GreeterOptions> {\n  return { name, excited: name.length % 2 === 0 }\n}\n\nexport const DEFAULT_RESULT: ResultInfo = {\n  kind: 'success',\n  payload: { name: 'Bot', excited: true }\n}\n\nexport function add(a: number, b: number) {\n  return a + b\n}\n\nexport class Greeter {\n  constructor(private readonly options: GreeterOptions) {}\n  greet(times: number) {\n    const base = this.options.excited ? this.options.name.toUpperCase() : this.options.name\n    return Array.from({ length: times }).map(() => base).join(' ')\n  }\n  async greetAsync(times: number): Promise<string[]> {\n    const base = this.options.excited ? this.options.name.toUpperCase() : this.options.name\n    return Array.from({ length: times }).map(() => base)\n  }\n  static async version(): Promise<string> {\n    return '1.0.0'\n  }\n}\n`,
      'utf-8'
    )
    mockedPacote.manifest.mockResolvedValue({ name: 'mock-lib', version: '1.0.0', types: 'index.ts' } as any)
    mockedPacote.extract.mockImplementation(async (_spec: string, target?: string) => {
      if (!target) throw new Error('missing target path')
      await fsp.cp(fixtureDir, target, { recursive: true })
      return {} as any
    })
  })

  afterEach(async () => {
    await fsp.rm(fixtureDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('produces function and class contracts from extracted package', async () => {
    const result = await generatePackageContracts('mock-lib')
    expect(result.contracts.length).toBeGreaterThan(0)

    const addContract = result.contracts.find(
      (contract) => contract.kind === 'function' && contract.exportName === 'add'
    )
    expect(addContract).toBeDefined()
    expect((addContract as FunctionContract).parameters[0].schema.recipe.kind).toBe('number')
    expect((addContract as FunctionContract).isAsync).toBe(false)

    const fetchProfileContract = result.contracts.find(
      (contract): contract is FunctionContract => contract.kind === 'function' && contract.exportName === 'fetchProfile'
    )
    expect(fetchProfileContract?.isAsync).toBe(true)
    expect(fetchProfileContract?.returns?.recipe.kind).toBe('promise')
    if (fetchProfileContract?.returns?.recipe.kind === 'promise') {
      expect(fetchProfileContract.returns.recipe.inner.kind).toBe('object')
    }

    const greeterContract = result.contracts.find(
      (contract): contract is ClassContract => contract.kind === 'class' && contract.exportName === 'Greeter'
    )
    expect(greeterContract?.kind).toBe('class')
    expect(greeterContract?.constructor?.parameters.length ?? 0).toBeGreaterThanOrEqual(1)
    const greetMethod = greeterContract?.methods.find((method) => method.name === 'greet')
    expect(greetMethod?.isAsync).toBe(false)
    const greetAsyncMethod = greeterContract?.methods.find((method) => method.name === 'greetAsync')
    expect(greetAsyncMethod?.isAsync).toBe(true)
    expect(greetAsyncMethod?.returns?.recipe.kind).toBe('promise')
    const versionMethod = greeterContract?.methods.find((method) => method.name === 'version')
    expect(versionMethod?.scope).toBe('static')
    expect(versionMethod?.isAsync).toBe(true)
  })
})

describe('dependency command helpers', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'npm-deps-'))
    await fsp.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'tmp', version: '0.0.0' }))
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('runs npm install with provided packages', async () => {
    await installDependencies(['left-pad@1.0.0'], { cwd: tempDir, dev: true })
    expect(mockedSpawn).toHaveBeenCalledWith(
      'npm',
      expect.arrayContaining(['install', 'left-pad@1.0.0', '--save-dev']),
      expect.objectContaining({ cwd: tempDir })
    )
  })

  it('runs npm uninstall with provided packages', async () => {
    await uninstallDependencies(['left-pad'], { cwd: tempDir })
    expect(mockedSpawn).toHaveBeenCalledWith(
      'npm',
      expect.arrayContaining(['uninstall', 'left-pad']),
      expect.objectContaining({ cwd: tempDir })
    )
  })
})

function makeNumberSchema(name: string): SchemaDescriptor {
  const recipe: ZodRecipe = { kind: 'number' }
  return {
    tsType: 'number',
    recipe,
    zod: 'z.number()',
    jsonSchema: { title: `${name}Number`, type: 'number' }
  }
}

describe('invokeLibraryContract', () => {
  it('executes the target function inside a worker', async () => {
    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'npm-worker-'))
    try {
      await fsp.writeFile(path.join(workDir, 'package.json'), JSON.stringify({ name: 'worker-app', version: '0.0.0' }))
      const entryPath = path.join(workDir, 'adder.js')
      await fsp.writeFile(
        entryPath,
        'module.exports = { async add(a, b) { return Promise.resolve(a + b) } }',
        'utf-8'
      )

      const contract: FunctionContract = {
        kind: 'function',
        exportName: 'add',
        sourceFile: 'adder.js',
        signature: '(a: number, b: number) => number',
        parameters: [
          { name: 'a', optional: false, schema: makeNumberSchema('a') },
          { name: 'b', optional: false, schema: makeNumberSchema('b') }
        ],
        returns: makeNumberSchema('result'),
        isAsync: true
      }

      const result = await invokeLibraryContract({
        cwd: workDir,
        packageSpecifier: entryPath,
        contract,
        args: { a: 2, b: 3 },
        timeoutMs: 5000
      })

      expect(result).toBe(5)
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true })
    }
  })
})
