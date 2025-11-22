import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import pacote from 'pacote'
import ts from 'typescript'
import { Worker } from 'worker_threads'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

const fsp = fs.promises
const COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  declaration: false,
  esModuleInterop: true,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  noEmit: true,
  skipLibCheck: true,
  strict: false,
  target: ts.ScriptTarget.ES2020
}
const MAX_SCHEMA_DEPTH = 4
const TEMP_PREFIX = 'hyperagent-npm-'

export type JsonSchema = Record<string, any>
export type ZodRecipe =
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'bigint' }
  | { kind: 'symbol' }
  | { kind: 'date' }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'undefined' }
  | { kind: 'promise'; inner: ZodRecipe }
  | { kind: 'array'; items: ZodRecipe }
  | { kind: 'tuple'; items: ZodRecipe[] }
  | { kind: 'object'; entries: Record<string, { schema: ZodRecipe; optional?: boolean }> }
  | { kind: 'union'; anyOf: ZodRecipe[] }
  | { kind: 'optional'; inner: ZodRecipe }
  | { kind: 'nullable'; inner: ZodRecipe }
  | { kind: 'record'; value: ZodRecipe }
  | { kind: 'any' }
  | { kind: 'unknown' }
  | { kind: 'never' }

export type SchemaDescriptor = {
  tsType: string
  recipe: ZodRecipe
  zod: string
  jsonSchema: JsonSchema
}

export type ContractParameter = {
  name: string
  optional: boolean
  schema: SchemaDescriptor
}

export type MethodContract = {
  name: string
  scope: 'instance' | 'static'
  signature: string
  parameters: ContractParameter[]
  returns?: SchemaDescriptor
  description?: string
  isAsync: boolean
}

export type ConstructorContract = {
  signature: string
  parameters: ContractParameter[]
}

export type FunctionContract = {
  kind: 'function'
  exportName: string
  sourceFile: string
  description?: string
  signature: string
  parameters: ContractParameter[]
  returns?: SchemaDescriptor
  isAsync: boolean
}

export type ClassContract = {
  kind: 'class'
  exportName: string
  sourceFile: string
  description?: string
  constructor?: ConstructorContract
  methods: MethodContract[]
}

export type ObjectContract = {
  kind: 'object'
  exportName: string
  sourceFile: string
  description?: string
  schema: SchemaDescriptor
}

export type PackageContract = FunctionContract | ClassContract | ObjectContract

export type PackageIntrospection = {
  spec: string
  name: string
  version: string
  entry: string
  contracts: PackageContract[]
}

export type DependencyCommandOptions = {
  cwd: string
  dev?: boolean
  registry?: string
}

export type InvokeContractOptions = {
  cwd: string
  packageSpecifier: string
  contract: PackageContract
  args?: ArgsInput
  constructorArgs?: ArgsInput
  method?: string
  timeoutMs?: number
}

type ArgsInput = unknown[] | Record<string, unknown> | undefined

type ModuleManifest = {
  name?: string
  version?: string
  main?: string
  module?: string
  types?: string
  typings?: string
  exports?: unknown
}

type WorkerPayload = {
  ok: boolean
  result?: unknown
  error?: string
  stack?: string
}

type WorkerRequest = {
  anchorPath: string
  packageSpecifier: string
  exportName: string
  contractKind: PackageContract['kind']
  args: unknown[]
  constructorArgs: unknown[]
  method?: string
  methodScope?: 'instance' | 'static'
}

const WORKER_SOURCE = `
  const { parentPort, workerData } = require('worker_threads');
  const { createRequire } = require('module');

  async function run() {
    const req = createRequire(workerData.anchorPath);
    let loaded = req(workerData.packageSpecifier);
    const exportName = workerData.exportName;

    let target = undefined;
    if (exportName === 'default') {
      target = loaded && loaded.default !== undefined ? loaded.default : loaded;
    } else if (loaded && typeof loaded === 'object') {
      if (exportName in loaded) {
        target = loaded[exportName];
      } else if (loaded.default && typeof loaded.default === 'object' && exportName in loaded.default) {
        target = loaded.default[exportName];
      }
    }

    if (target === undefined) {
      if (exportName === 'default') {
        target = loaded;
      }
    }

    if (target === undefined) {
      throw new Error('Unable to locate export "' + exportName + '"');
    }

    const args = workerData.args || [];
    const ctorArgs = workerData.constructorArgs || [];

    if (workerData.contractKind === 'function') {
      if (typeof target !== 'function') {
        throw new Error('Export "' + exportName + '" is not callable');
      }
      return await Promise.resolve(target(...args));
    }

    if (typeof target !== 'function') {
      throw new Error('Export "' + exportName + '" is not a class or factory');
    }

    const ClassRef = target;
    if (workerData.method) {
      if (workerData.methodScope === 'static') {
        const fn = ClassRef[workerData.method];
        if (typeof fn !== 'function') {
          throw new Error('Static method not found: ' + workerData.method);
        }
        return await Promise.resolve(fn.apply(ClassRef, args));
      }
      const instance = new ClassRef(...ctorArgs);
      const method = instance[workerData.method];
      if (typeof method !== 'function') {
        throw new Error('Instance method not found: ' + workerData.method);
      }
      return await Promise.resolve(method.apply(instance, args));
    }

    return new ClassRef(...args);
  }

  run()
    .then((result) => parentPort.postMessage({ ok: true, result }))
    .catch((err) => {
      const message = err && err.message ? err.message : String(err);
      parentPort.postMessage({ ok: false, error: message, stack: err && err.stack ? err.stack : undefined });
    });
`

export async function generatePackageContracts(spec: string): Promise<PackageIntrospection> {
  const manifest = (await pacote.manifest(spec)) as ModuleManifest
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX))
  try {
    await pacote.extract(spec, tempDir)
    const entryRel = resolveEntryCandidate(manifest)
    const entryAbs = await resolveEntryFile(tempDir, entryRel)

    const program = ts.createProgram([entryAbs], COMPILER_OPTIONS)
    const checker = program.getTypeChecker()
    const sourceFile = program.getSourceFile(entryAbs)
    if (!sourceFile) {
      throw new Error(`Unable to load source file for ${entryRel}`)
    }

    const moduleSymbol = checker.getSymbolAtLocation(sourceFile) ?? (sourceFile as any).symbol
    if (!moduleSymbol) {
      throw new Error('Unable to resolve module symbol for entry file')
    }

    const contracts = extractContracts(moduleSymbol, checker, tempDir)
    return {
      spec,
      name: manifest.name ?? spec,
      version: manifest.version ?? 'latest',
      entry: path.relative(tempDir, entryAbs) || path.basename(entryAbs),
      contracts
    }
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true })
  }
}

export async function installDependencies(packages: string[], options: DependencyCommandOptions): Promise<void> {
  await runNpmCommand('install', packages, options)
}

export async function uninstallDependencies(packages: string[], options: DependencyCommandOptions): Promise<void> {
  await runNpmCommand('uninstall', packages, options)
}

export async function invokeLibraryContract(options: InvokeContractOptions): Promise<unknown> {
  const { cwd, packageSpecifier, contract, method, timeoutMs = 20000 } = options
  if (!cwd) throw new Error('cwd is required to invoke a contract')
  if (!packageSpecifier) throw new Error('packageSpecifier is required to invoke a contract')
  await ensureDirectory(cwd)

  if (contract.kind === 'object') {
    throw new Error('Object contracts are descriptive only and cannot be invoked')
  }

  const methodContract = method && contract.kind === 'class' ? contract.methods.find((m) => m.name === method) : undefined
  if (method && !methodContract) {
    throw new Error(`Method ${method} not found on contract ${contract.exportName}`)
  }

  const functionArgs =
    contract.kind === 'function'
      ? buildArgumentArray(contract.parameters, options.args, `${contract.exportName} arguments`)
      : []

  let classConstructorArgs: unknown[] = []
  let classInvokeArgs: unknown[] = []
  if (contract.kind === 'class') {
    if (methodContract) {
      if (methodContract.scope === 'instance') {
        classConstructorArgs = buildArgumentArray(
          contract.constructor?.parameters,
          options.constructorArgs,
          `${contract.exportName} constructor`
        )
      }
      classInvokeArgs = buildArgumentArray(methodContract.parameters, options.args, `${contract.exportName}.${methodContract.name}`)
    } else {
      classConstructorArgs = buildArgumentArray(
        contract.constructor?.parameters,
        options.args,
        `${contract.exportName} constructor`
      )
    }
  }

  const { anchorPath, cleanup } = await ensureRequireAnchor(cwd)
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      anchorPath,
      packageSpecifier,
      exportName: contract.exportName,
      contractKind: contract.kind,
      args: contract.kind === 'function' ? functionArgs : methodContract ? classInvokeArgs : classConstructorArgs,
      constructorArgs: methodContract ? classConstructorArgs : [],
      method: methodContract?.name,
      methodScope: methodContract?.scope
    } satisfies WorkerRequest
  })

  return new Promise<unknown>((resolve, reject) => {
    let settled = false
    let anchorRemoved = false
    let timer: NodeJS.Timeout | undefined

    const cleanupAnchorFile = () => {
      if (!cleanup || anchorRemoved) return
      anchorRemoved = true
      fsp.rm(anchorPath, { force: true }).catch(() => undefined)
    }

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
    }

    if (timeoutMs) {
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanupAnchorFile()
        worker.terminate().catch(() => undefined)
        reject(new Error('Worker invocation timed out'))
      }, timeoutMs)
    }

    worker.once('message', (payload: WorkerPayload) => {
      if (settled) return
      settled = true
      clearTimer()
      cleanupAnchorFile()
      worker.terminate().catch(() => undefined)
      if (payload.ok) {
        resolve(payload.result)
      } else {
        reject(new Error(payload.error || 'Unknown worker error'))
      }
    })

    worker.once('error', (err) => {
      if (settled) return
      settled = true
      clearTimer()
      cleanupAnchorFile()
      reject(err)
    })

    worker.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimer()
      cleanupAnchorFile()
      if (code === 0) {
        reject(new Error('Worker exited before returning a result'))
      } else {
        reject(new Error(`Worker exited with code ${code}`))
      }
    })
  })
}

function resolveEntryCandidate(manifest: ModuleManifest): string {
  const candidates: string[] = []
  const exportsCandidates = collectExports(manifest.exports)
  ;[
    manifest.types,
    manifest.typings,
    ...exportsCandidates,
    manifest.module,
    manifest.main,
    'index.ts',
    'index.js'
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .forEach((value) => candidates.push(value))
  return candidates[0] ?? 'index.js'
}

function collectExports(exportsField: unknown): string[] {
  if (!exportsField) return []
  if (typeof exportsField === 'string') return [exportsField]
  if (typeof exportsField === 'object') {
    const root = (exportsField as Record<string, unknown>)['.'] ?? exportsField
    if (typeof root === 'string') return [root]
    if (typeof root === 'object' && root) {
      const ordered = ['types', 'import', 'require', 'default']
      for (const key of ordered) {
        const val = (root as Record<string, unknown>)[key]
        if (typeof val === 'string') return [val]
        if (typeof val === 'object' && val && typeof (val as Record<string, unknown>).default === 'string') {
          return [(val as Record<string, string>).default]
        }
      }
    }
  }
  return []
}

async function resolveEntryFile(root: string, entryRel: string): Promise<string> {
  const absolute = path.resolve(root, entryRel)
  const candidates = buildEntryCandidates(absolute)
  for (const candidate of candidates) {
    if (!(await fileExists(candidate))) continue
    const stats = await fsp.stat(candidate)
    if (stats.isFile()) return candidate
    if (stats.isDirectory()) {
      const nested = buildIndexCandidates(candidate)
      for (const file of nested) {
        if (await fileExists(file)) return file
      }
    }
  }
  throw new Error(`Unable to locate entry file for ${entryRel}`)
}

function buildEntryCandidates(base: string): string[] {
  const withoutExt = base.replace(/\.[^/.]+$/, '')
  const suffixes = ['', '.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']
  const values = new Set<string>()
  suffixes.forEach((suffix) => {
    const candidate = suffix ? `${withoutExt}${suffix}` : base
    values.add(candidate)
  })
  return Array.from(values)
}

function buildIndexCandidates(dir: string): string[] {
  return ['index.ts', 'index.tsx', 'index.d.ts', 'index.js', 'index.mjs', 'index.cjs'].map((file) => path.join(dir, file))
}

function extractContracts(moduleSymbol: ts.Symbol, checker: ts.TypeChecker, root: string): PackageContract[] {
  const mapped = checker.getExportsOfModule(moduleSymbol)
  const results: PackageContract[] = []
  for (const symbol of mapped) {
    const contract = buildContract(symbol, checker, root)
    if (contract) {
      results.push(contract)
    }
  }
  return results
}

function buildContract(symbol: ts.Symbol, checker: ts.TypeChecker, root: string): PackageContract | undefined {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
  if (!declaration) return undefined
  const exportName = normalizeExportName(symbol.getName())
  const description = ts.displayPartsToString(symbol.getDocumentationComment(checker)) || undefined
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration)
  const sourceFile = declaration.getSourceFile().fileName
  const relativeSource = path.relative(root, sourceFile)

  const constructSignatures = checker.getSignaturesOfType(type, ts.SignatureKind.Construct)
  const callSignatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call)

  if (constructSignatures.length > 0 || ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) {
    return buildClassContract(exportName, description, declaration, constructSignatures, checker, relativeSource)
  }

  if (callSignatures.length > 0) {
    return buildFunctionContract(exportName, description, callSignatures[0], checker, relativeSource)
  }

  if (typeIsObjectLike(type, checker)) {
    const schema = describeType(type, checker, exportName)
    return {
      kind: 'object',
      exportName,
      description,
      sourceFile: relativeSource,
      schema
    }
  }

  return undefined
}

function buildFunctionContract(
  exportName: string,
  description: string | undefined,
  signature: ts.Signature,
  checker: ts.TypeChecker,
  sourceFile: string
): FunctionContract {
  const returnType = signature.getReturnType()
  return {
    kind: 'function',
    exportName,
    description,
    sourceFile,
    signature: checker.signatureToString(signature),
    parameters: buildParameters(signature, checker),
    returns: describeType(returnType, checker, `${exportName}Return`),
    isAsync: isPromiseLike(returnType, checker)
  }
}

function buildClassContract(
  exportName: string,
  description: string | undefined,
  declaration: ts.Declaration,
  constructSignatures: readonly ts.Signature[],
  checker: ts.TypeChecker,
  sourceFile: string
): ClassContract {
  const ctorSignature = constructSignatures[constructSignatures.length - 1]
  const constructorContract = ctorSignature
    ? {
        signature: checker.signatureToString(ctorSignature),
        parameters: buildParameters(ctorSignature, checker)
      }
    : undefined

  const methods: MethodContract[] = []
  if (isClassLikeDeclaration(declaration)) {
    for (const member of declaration.members) {
      if (!ts.isMethodDeclaration(member)) continue
      const method = buildMethodContract(member, checker)
      if (method) methods.push(method)
    }
  }

  return {
    kind: 'class',
    exportName,
    description,
    sourceFile,
    constructor: constructorContract,
    methods
  }
}

function buildMethodContract(member: ts.MethodDeclaration, checker: ts.TypeChecker): MethodContract | undefined {
  if (!member.name || !ts.isIdentifier(member.name)) return undefined
  const signature = checker.getSignatureFromDeclaration(member)
  if (!signature) return undefined
  const returnType = signature.getReturnType()
  const doc = ts.displayPartsToString(signature.getDocumentationComment(checker)) || undefined
  return {
    name: member.name.text,
    scope: member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ? 'static' : 'instance',
    signature: checker.signatureToString(signature),
    parameters: buildParameters(signature, checker),
    returns: describeType(returnType, checker, `${member.name.text}Return`),
    description: doc,
    isAsync: isPromiseLike(returnType, checker)
  }
}

function buildParameters(signature: ts.Signature, checker: ts.TypeChecker): ContractParameter[] {
  return signature.parameters.map((param, index) => {
    const declaration = param.declarations?.[0]
    const name = sanitizeParameterName(param.getName(), index)
    const optional = Boolean(param.flags & ts.SymbolFlags.Optional) || isOptionalParameter(declaration)
    const location =
      (declaration as ts.Declaration | undefined) ??
      (param.valueDeclaration as ts.Declaration | undefined) ??
      (signature.declaration as ts.Declaration | undefined) ??
      ((param.declarations?.[0] as ts.Declaration) ?? undefined)

    let schema: SchemaDescriptor
    if (location) {
      schema = describeType(checker.getTypeOfSymbolAtLocation(param, location), checker, `${name}Param`)
    } else {
      const fallbackRecipe: ZodRecipe = { kind: 'unknown' }
      schema = {
        tsType: 'unknown',
        recipe: fallbackRecipe,
        zod: recipeToString(fallbackRecipe),
        jsonSchema: recipeToJsonSchema(fallbackRecipe, `${name}Param`)
      }
    }
    return {
      name,
      optional,
      schema
    }
  })
}

function describeType(type: ts.Type, checker: ts.TypeChecker, label: string): SchemaDescriptor {
  const recipe = typeToRecipe(type, checker)
  return {
    tsType: checker.typeToString(type),
    recipe,
    zod: recipeToString(recipe),
    jsonSchema: recipeToJsonSchema(recipe, label)
  }
}

function typeToRecipe(type: ts.Type, checker: ts.TypeChecker, depth = 0, stack = new Set<number>()): ZodRecipe {
  if (!type) return { kind: 'any' }
  if (depth > MAX_SCHEMA_DEPTH) return { kind: 'any' }
  const typeId = (type as any).id as number | undefined
  if (typeId && stack.has(typeId)) return { kind: 'any' }
  if (typeId) stack.add(typeId)
  const finish = (recipe: ZodRecipe) => {
    if (typeId) stack.delete(typeId)
    return recipe
  }

  const flags = type.flags
  if (flags & ts.TypeFlags.Any) return finish({ kind: 'any' })
  if (flags & ts.TypeFlags.Unknown) return finish({ kind: 'unknown' })
  if (flags & ts.TypeFlags.Never) return finish({ kind: 'never' })

  if (flags & ts.TypeFlags.StringLiteral) return finish({ kind: 'literal', value: (type as ts.StringLiteralType).value })
  if (flags & ts.TypeFlags.NumberLiteral) return finish({ kind: 'literal', value: (type as ts.NumberLiteralType).value })
  if (flags & ts.TypeFlags.BooleanLiteral) {
    const intrinsic = (type as ts.Type & { intrinsicName?: string }).intrinsicName
    return finish({ kind: 'literal', value: intrinsic === 'true' })
  }

  if (flags & ts.TypeFlags.StringLike) return finish({ kind: 'string' })
  if (flags & ts.TypeFlags.NumberLike) return finish({ kind: 'number' })
  if (flags & ts.TypeFlags.BooleanLike) return finish({ kind: 'boolean' })
  if (flags & ts.TypeFlags.BigIntLike) return finish({ kind: 'bigint' })
  if (flags & ts.TypeFlags.ESSymbolLike) return finish({ kind: 'symbol' })
  if (flags & ts.TypeFlags.Null) return finish({ kind: 'literal', value: null })
  if (flags & ts.TypeFlags.Undefined || flags & ts.TypeFlags.Void) return finish({ kind: 'undefined' })

  const promiseInner = getPromiseInnerType(type, checker)
  if (promiseInner) {
    return finish({ kind: 'promise', inner: typeToRecipe(promiseInner, checker, depth + 1, stack) })
  }

  if (flags & ts.TypeFlags.Union) {
    const union = type as ts.UnionType
    const hasUndefined = union.types.some((t) => Boolean(t.flags & ts.TypeFlags.Undefined || t.flags & ts.TypeFlags.Void))
    const hasNull = union.types.some((t) => Boolean(t.flags & ts.TypeFlags.Null))
    const filteredTypes = union.types.filter(
      (t) => !(t.flags & ts.TypeFlags.Undefined) && !(t.flags & ts.TypeFlags.Void) && !(t.flags & ts.TypeFlags.Null)
    )
    const options = filteredTypes.length
      ? filteredTypes.map((inner) => typeToRecipe(inner, checker, depth + 1, stack))
      : ([{ kind: 'any' }] as ZodRecipe[])
    let core: ZodRecipe = options.length === 1 ? options[0] : { kind: 'union', anyOf: options }
    if (hasNull) core = { kind: 'nullable', inner: core }
    if (hasUndefined) core = { kind: 'optional', inner: core }
    return finish(core)
  }

  if (checker.isArrayType(type)) {
    const ref = type as ts.TypeReference
    const element = ref.typeArguments?.[0]
    const items = element ? typeToRecipe(element, checker, depth + 1, stack) : ({ kind: 'any' } as ZodRecipe)
    return finish({ kind: 'array', items } as ZodRecipe)
  }

  if (checker.isTupleType(type)) {
    const tuple = type as ts.TupleType
    const args = tuple.typeArguments ?? []
    const items = args.map((arg) => typeToRecipe(arg, checker, depth + 1, stack))
    return finish({ kind: 'tuple', items })
  }

  if (isDateType(type)) {
    return finish({ kind: 'date' })
  }

  const indexType = checker.getIndexTypeOfType(type, ts.IndexKind.String)
  if (indexType) {
    return finish({ kind: 'record', value: typeToRecipe(indexType, checker, depth + 1, stack) })
  }

  if (typeIsObjectLike(type, checker)) {
    const entries: Record<string, { schema: ZodRecipe; optional?: boolean }> = {}
    for (const prop of checker.getPropertiesOfType(type)) {
      const name = prop.getName()
      const declaration = prop.valueDeclaration ?? prop.declarations?.[0]
      if (!declaration) continue
      const propertyType = checker.getTypeOfSymbolAtLocation(prop, declaration)
      entries[name] = {
        schema: typeToRecipe(propertyType, checker, depth + 1, stack),
        optional: Boolean(prop.flags & ts.SymbolFlags.Optional) || typeIsOptionalType(propertyType)
      }
    }
    return finish({ kind: 'object', entries })
  }

  return finish({ kind: 'any' })
}

function typeIsObjectLike(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (!(type.flags & ts.TypeFlags.Object)) return false
  return checker.getPropertiesOfType(type).length > 0
}

function typeIsOptionalType(type: ts.Type): boolean {
  if (!type) return false
  if (type.flags & ts.TypeFlags.Undefined || type.flags & ts.TypeFlags.Void) return true
  if (type.flags & ts.TypeFlags.Union) {
    return (type as ts.UnionType).types.some((sub) => typeIsOptionalType(sub))
  }
  return false
}

function isDateType(type: ts.Type): boolean {
  return Boolean(type.symbol && type.symbol.escapedName === 'Date')
}

function isPromiseLike(type: ts.Type, checker: ts.TypeChecker): boolean {
  return Boolean(getPromiseInnerType(type, checker))
}

function getPromiseInnerType(type: ts.Type, checker: ts.TypeChecker): ts.Type | undefined {
  const maybeFn = (checker as any).getPromisedTypeOfPromise as ((t: ts.Type) => ts.Type | undefined) | undefined
  if (maybeFn) {
    const resolved = maybeFn.call(checker, type)
    if (resolved) return resolved
  }
  if (type.symbol?.escapedName === 'Promise' && (type as ts.TypeReference).typeArguments?.length) {
    return (type as ts.TypeReference).typeArguments?.[0]
  }
  return undefined
}

function recipeToZod(recipe: ZodRecipe): z.ZodTypeAny {
  switch (recipe.kind) {
    case 'string':
      return z.string()
    case 'number':
      return z.number()
    case 'boolean':
      return z.boolean()
    case 'bigint':
      return z.bigint()
    case 'symbol':
      return z.symbol()
    case 'date':
      return z.date()
    case 'literal':
      return z.literal(recipe.value as any)
    case 'undefined':
      return z.undefined()
    case 'promise':
      return z.promise(recipeToZod(recipe.inner))
    case 'array':
      return z.array(recipeToZod(recipe.items))
    case 'tuple':
      return z.tuple(recipe.items.map((item) => recipeToZod(item)) as any)
    case 'object': {
      const shape: Record<string, z.ZodTypeAny> = {}
      for (const [key, value] of Object.entries(recipe.entries)) {
        const schema = recipeToZod(value.schema)
        shape[key] = value.optional ? schema.optional() : schema
      }
      return z.object(shape)
    }
    case 'union': {
      if (recipe.anyOf.length === 0) return z.any()
      if (recipe.anyOf.length === 1) return recipeToZod(recipe.anyOf[0])
      const [first, second, ...rest] = recipe.anyOf
      let union = z.union([recipeToZod(first), recipeToZod(second)])
      for (const option of rest) {
        union = union.or(recipeToZod(option))
      }
      return union
    }
    case 'optional':
      return recipeToZod(recipe.inner).optional()
    case 'nullable':
      return recipeToZod(recipe.inner).nullable()
    case 'record':
      return z.record(z.string(), recipeToZod(recipe.value))
    case 'unknown':
      return z.unknown()
    case 'never':
      return z.never()
    default:
      return z.any()
  }
}

function recipeToString(recipe: ZodRecipe): string {
  switch (recipe.kind) {
    case 'string':
      return 'z.string()'
    case 'number':
      return 'z.number()'
    case 'boolean':
      return 'z.boolean()'
    case 'bigint':
      return 'z.bigint()'
    case 'symbol':
      return 'z.symbol()'
    case 'date':
      return 'z.date()'
    case 'literal':
      return `z.literal(${JSON.stringify(recipe.value)})`
    case 'undefined':
      return 'z.undefined()'
    case 'promise':
      return `z.promise(${recipeToString(recipe.inner)})`
    case 'array':
      return `z.array(${recipeToString(recipe.items)})`
    case 'tuple':
      return `z.tuple([${recipe.items.map((item) => recipeToString(item)).join(', ')}])`
    case 'object':
      return `z.object({${Object.entries(recipe.entries)
        .map(([key, value]) => `${JSON.stringify(key)}: ${recipeToString(value.schema)}${value.optional ? '.optional()' : ''}`)
        .join(', ')}})`
    case 'union':
      return `z.union([${recipe.anyOf.map((item) => recipeToString(item)).join(', ')}])`
    case 'optional':
      return `${recipeToString(recipe.inner)}.optional()`
    case 'nullable':
      return `${recipeToString(recipe.inner)}.nullable()`
    case 'record':
      return `z.record(z.string(), ${recipeToString(recipe.value)})`
    case 'unknown':
      return 'z.unknown()'
    case 'never':
      return 'z.never()'
    default:
      return 'z.any()'
  }
}

function recipeToJsonSchema(recipe: ZodRecipe, label: string): JsonSchema {
  if (recipe.kind === 'promise') {
    const inner = recipeToJsonSchema(recipe.inner, label)
    const annotated = { ...inner }
    const promiseDescription = `Promise resolving to ${label}`
    annotated.description = annotated.description
      ? `${promiseDescription}. ${annotated.description}`
      : promiseDescription
    return annotated
  }
  const schema = recipeToZod(recipe)
  const safeLabel = label.replace(/[^a-z0-9_]/gi, '_') || 'Schema'
  const definition = zodToJsonSchema(schema as any, safeLabel)
  return JSON.parse(JSON.stringify(definition))
}

async function runNpmCommand(command: 'install' | 'uninstall', packages: string[], options: DependencyCommandOptions): Promise<void> {
  if (!options?.cwd) throw new Error('cwd is required to run npm commands')
  if (packages.length === 0) return
  await ensureDirectory(options.cwd)
  const args = [command, ...packages]
  if (command === 'install' && options.dev) {
    args.push('--save-dev')
  }
  if (command === 'uninstall' && options.dev) {
    args.push('--save-dev')
  }
  if (options.registry) {
    args.push('--registry', options.registry)
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stderr = ''
    child.stderr?.on('data', (chunk) => (stderr += String(chunk)))

    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`npm ${command} failed with code ${code}: ${stderr.trim()}`))
      } else {
        resolve()
      }
    })
  })
}

async function ensureDirectory(dir: string): Promise<void> {
  const stats = await fsp.stat(dir).catch(() => undefined)
  if (!stats || !stats.isDirectory()) {
    throw new Error(`Directory does not exist: ${dir}`)
  }
}

async function ensureRequireAnchor(cwd: string): Promise<{ anchorPath: string; cleanup: boolean }> {
  const packageJson = path.join(cwd, 'package.json')
  if (await fileExists(packageJson)) {
    return { anchorPath: packageJson, cleanup: false }
  }
  const anchorPath = path.join(cwd, `.hyperagent-require-anchor-${process.pid}-${Date.now()}.cjs`)
  await fsp.writeFile(anchorPath, 'module.exports = {}\n', 'utf-8')
  return { anchorPath, cleanup: true }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

function normalizeExportName(name: string): string {
  if (name === ts.InternalSymbolName.Default || name === 'default') return 'default'
  return name
}

function sanitizeParameterName(name: string, index: number): string {
  if (!name || name === '__namedParameters') return `arg${index}`
  return name
}

function isOptionalParameter(node: ts.Declaration | undefined): boolean {
  if (!node) return false
  if (ts.isParameter(node)) {
    return Boolean(node.questionToken || node.initializer)
  }
  return false
}

type ClassLikeDeclaration = ts.ClassDeclaration | ts.ClassExpression

function isClassLikeDeclaration(node: ts.Declaration): node is ClassLikeDeclaration {
  return ts.isClassDeclaration(node) || ts.isClassExpression(node)
}

function buildArgumentArray(
  definition: ContractParameter[] | undefined,
  input: ArgsInput,
  label: string
): unknown[] {
  if (!definition) {
    if (Array.isArray(input)) return input
    if (input && typeof input === 'object') return Object.values(input)
    return []
  }

  if (definition.length === 0) {
    if (Array.isArray(input)) return input
    if (input && typeof input === 'object') return []
    return []
  }

  const record = normalizeArgumentRecord(definition, input)
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const param of definition) {
    let schema = recipeToZod(param.schema.recipe)
    if (param.optional) {
      schema = schema.optional()
    }
    shape[param.name] = schema
  }
  const objectSchema = z.object(shape).passthrough()
  const parsed = objectSchema.safeParse(record)
  if (!parsed.success) {
    throw new Error(`Argument validation failed for ${label}: ${parsed.error.message}`)
  }
  return definition.map((param) => parsed.data[param.name])
}

function normalizeArgumentRecord(
  definition: ContractParameter[],
  input: ArgsInput
): Record<string, unknown> {
  if (Array.isArray(input)) {
    const record: Record<string, unknown> = {}
    definition.forEach((param, index) => {
      record[param.name] = input[index]
    })
    return record
  }
  if (input && typeof input === 'object') {
    return { ...(input as Record<string, unknown>) }
  }
  return {}
}
