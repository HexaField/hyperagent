import fs from 'fs'
import os from 'os'
import { execSync } from 'child_process'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const fsp = fs.promises

describe('generatePackageContracts', () => {
  let fixtureDir: string

  let packedTarball: string | undefined

  beforeEach(async () => {
    fixtureDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'npm-fixture-'))
    await fsp.writeFile(
      path.join(fixtureDir, 'package.json'),
      JSON.stringify({ name: 'mock-lib', version: '1.0.0', types: 'index.ts' }),
      'utf-8'
    )

    await fsp.writeFile(
      path.join(fixtureDir, 'index.ts'),
      `export interface GreeterOptions {\n  name: string\n  excited?: boolean\n}\n\nexport type ResultInfo =\n  | { kind: 'success'; payload: GreeterOptions }\n  | { kind: 'failure'; message: string }\n\nexport async function fetchProfile(name: string): Promise<GreeterOptions> {\n  return { name, excited: name.length % 2 === 0 }\n}\n\nexport const DEFAULT_RESULT: ResultInfo = {\n  kind: 'success',\n  payload: { name: 'Bot', excited: true }\n}\n\nexport function add(a: number, b: number) {\n  return a + b\n}\n\nexport class Greeter {\n  constructor(private readonly options: GreeterOptions) {}\n  greet(times: number) {\n    const base = this.options.excited ? this.options.name.toUpperCase() : this.options.name\n    return Array.from({ length: times }).map(() => base).join(' ')\n  }\n  async greetAsync(times: number): Promise<string[]> {\n    const base = this.options.excited ? this.options.name.toUpperCase() : this.options.name\n    return Array.from({ length: times }).map(() => base)\n  }\n  static async version(): Promise<string> {\n    return '1.0.0'\n  }\n}\n`,
      'utf-8'
    )
    // Create a tarball so pacote.extract can operate on a file spec instead of a directory
    const out = execSync('npm pack', { cwd: fixtureDir })
    const tarName = out.toString().trim().split(/\r?\n/).pop() || ''
    packedTarball = path.join(fixtureDir, tarName)
  })

  afterEach(async () => {
    await fsp.rm(fixtureDir, { recursive: true, force: true })
  })

  it('produces function and class contracts from extracted package', async () => {
    // Use the generated tarball so pacote can extract it reliably
    const spec = `file:${packedTarball}`
    const result = await generatePackageContracts(spec)
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

  it('installs a local package via file: spec and records it in package.json', async () => {
    const depDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'local-dep-'))
    await fsp.writeFile(
      path.join(depDir, 'package.json'),
      JSON.stringify({ name: 'local-dep', version: '1.0.0', main: 'index.js' })
    )
    await fsp.writeFile(path.join(depDir, 'index.js'), 'module.exports = { ok: true }', 'utf-8')

    await installDependencies([`file:${depDir}`], { cwd: tempDir, dev: true })

    const pkgJson = JSON.parse(await fsp.readFile(path.join(tempDir, 'package.json'), 'utf-8'))
    const devDeps = pkgJson.devDependencies ?? {}
    expect(devDeps['local-dep'] ?? devDeps['local-dep']).toBeDefined()

    // node_modules should contain the installed package
    const installed = await fsp.stat(path.join(tempDir, 'node_modules', 'local-dep')).catch(() => undefined)
    expect(installed).toBeDefined()
  })

  it('uninstalls a previously installed local package', async () => {
    const depDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'local-dep-'))
    await fsp.writeFile(
      path.join(depDir, 'package.json'),
      JSON.stringify({ name: 'local-dep', version: '1.0.0', main: 'index.js' })
    )
    await fsp.writeFile(path.join(depDir, 'index.js'), 'module.exports = { ok: true }', 'utf-8')

    // install first
    await installDependencies([`file:${depDir}`], { cwd: tempDir, dev: true })

    // now uninstall
    await uninstallDependencies(['local-dep'], { cwd: tempDir })

    const pkgJsonAfter = JSON.parse(await fsp.readFile(path.join(tempDir, 'package.json'), 'utf-8'))
    const devDepsAfter = pkgJsonAfter.devDependencies ?? {}
    expect(devDepsAfter['local-dep']).toBeUndefined()

    const installedAfter = await fsp.stat(path.join(tempDir, 'node_modules', 'local-dep')).catch(() => undefined)
    expect(installedAfter).toBeUndefined()
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
      await fsp.writeFile(entryPath, 'module.exports = { async add(a, b) { return Promise.resolve(a + b) } }', 'utf-8')

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
