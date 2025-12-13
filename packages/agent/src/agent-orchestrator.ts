import type { FileDiff, Session } from '@opencode-ai/sdk'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { z } from 'zod'
import { AgentRunResponse, AgentStreamCallback, invokeStructuredJsonCall, parseJsonPayload } from './agent'
import { createSession, getMessageDiff, getSession } from './opencode'
import {
  RunMeta,
  createRunMeta,
  findLatestRoleDiff,
  findLatestRoleMessageId,
  hasRunMeta,
  loadRunMeta,
  recordUserMessage,
  saveRunMeta
} from './provenance'
import {
  AgentWorkflowDefinition,
  WorkflowCondition,
  WorkflowFieldCondition,
  WorkflowOutcomeTemplate,
  WorkflowStepDefinition,
  WorkflowTransitionDefinition,
  workflowDefinitionSchema,
  workflowParserSchemaToZod,
  type JsonSchemaType,
  type WorkflowParserJsonOutput,
  type WorkflowParserJsonSchema
} from './workflow-schema'

type AgentWorkflowRunOptionsBase = {
  sessionDir: string
  model?: string
  runID?: string
  maxRounds?: number
  onStream?: AgentStreamCallback
  workflowId?: string
  workflowSource?: 'builtin' | 'user'
  workflowLabel?: string
}
export type UserInputsFromDefinition<TDefinition extends AgentWorkflowDefinition> = TDefinition extends {
  user: infer U
}
  ? U extends Record<string, WorkflowParserJsonSchema>
    ? // Separate keys that have defaults (optional at runtime) from those that do not (required)
      {
        // required keys (no `default` present on the schema)
        [K in keyof U as U[K] extends { default?: unknown } ? never : K]: JsonSchemaType<U[K]>
      } & {
        // optional keys (have a `default` in the schema)
        [K in keyof U as U[K] extends { default?: unknown } ? K : never]?: JsonSchemaType<U[K]>
      }
    : Record<string, unknown>
  : Record<string, unknown>

export type AgentWorkflowRunOptions<TDefinition extends AgentWorkflowDefinition = AgentWorkflowDefinition> =
  AgentWorkflowRunOptionsBase & {
    /** Map of user-provided input values. Keys become available under `user.<key>` in templates. */
    user: UserInputsFromDefinition<TDefinition>
  }

export type WorkflowRoleName<TDefinition extends AgentWorkflowDefinition> = keyof TDefinition['roles'] & string

type ParserLookup<TDefinition extends AgentWorkflowDefinition> = {
  [Role in WorkflowRoleName<TDefinition>]: TDefinition['roles'][Role]['parser']
}

type ParserSchemaForRole<
  TDefinition extends AgentWorkflowDefinition,
  Role extends WorkflowRoleName<TDefinition>
> = NonNullable<TDefinition['parsers']>[ParserLookup<TDefinition>[Role] &
  keyof NonNullable<TDefinition['parsers']> &
  string]

type RoundStepDefinition<TDefinition extends AgentWorkflowDefinition> = TDefinition['flow']['round']['steps'][number]
type RoundStepKey<TDefinition extends AgentWorkflowDefinition> = RoundStepDefinition<TDefinition>['key']
type BootstrapStepDefinition<TDefinition extends AgentWorkflowDefinition> =
  NonNullable<TDefinition['flow']['bootstrap']> extends WorkflowStepDefinition
    ? NonNullable<TDefinition['flow']['bootstrap']>
    : never

type StepDefinitionByKey<TDefinition extends AgentWorkflowDefinition, TKey extends RoundStepKey<TDefinition>> = Extract<
  RoundStepDefinition<TDefinition>,
  { key: TKey }
>

type ParserOutputForRole<TDefinition extends AgentWorkflowDefinition, Role extends WorkflowRoleName<TDefinition>> =
  ParserSchemaForRole<TDefinition, Role> extends WorkflowParserJsonSchema
    ? WorkflowParserJsonOutput<ParserSchemaForRole<TDefinition, Role>>
    : unknown

type WorkflowTurnForStep<
  TDefinition extends AgentWorkflowDefinition,
  TStep extends WorkflowStepDefinition
> = TStep extends WorkflowStepDefinition
  ? {
      key: TStep['key']
      role: TStep['role']
      round: number
      raw: string
      parsed: ParserOutputForRole<TDefinition, TStep['role'] & WorkflowRoleName<TDefinition>>
    }
  : never

type RoundStepTurn<TDefinition extends AgentWorkflowDefinition> = WorkflowTurnForStep<
  TDefinition,
  RoundStepDefinition<TDefinition>
>

type BootstrapTurn<TDefinition extends AgentWorkflowDefinition> = WorkflowTurnForStep<
  TDefinition,
  BootstrapStepDefinition<TDefinition>
>

type AnyWorkflowTurn<TDefinition extends AgentWorkflowDefinition> =
  | RoundStepTurn<TDefinition>
  | BootstrapTurn<TDefinition>

export type AgentWorkflowTurn<TDefinition extends AgentWorkflowDefinition = AgentWorkflowDefinition> =
  | RoundStepTurn<TDefinition>
  | BootstrapTurn<TDefinition>

export type AgentWorkflowRound<TDefinition extends AgentWorkflowDefinition = AgentWorkflowDefinition> = {
  round: number
  steps: StepDictionary<TDefinition>
}

export type AgentWorkflowResult<TDefinition extends AgentWorkflowDefinition = AgentWorkflowDefinition> = {
  outcome: string
  reason: string
  bootstrap?: BootstrapTurn<TDefinition>
  rounds: Array<AgentWorkflowRound<TDefinition>>
}

export function loadWorkflowDefinition(filePath: string): AgentWorkflowDefinition {
  const __filename__ = fileURLToPath(import.meta.url)
  const __dirname__ = path.dirname(__filename__)
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(__dirname__, filePath)
  const contents = fs.readFileSync(resolved, 'utf8')
  const parsed = JSON.parse(contents)
  try {
    return workflowDefinitionSchema.parse(parsed)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Workflow definition at ${filePath} failed validation: ${message}`)
  }
}

type SessionMap = Record<string, Session>

const renderSimpleTemplate = (template: string, context: Record<string, string>): string => {
  return template.replace(/{{\s*([^}]+)\s*}}/g, (_, expr: string) => {
    const key = expr.trim()
    return context[key] ?? ''
  })
}

async function ensureWorkflowSessions(
  definition: AgentWorkflowDefinition,
  runId: string,
  directory: string,
  metaExtras?: Partial<RunMeta>
): Promise<SessionMap> {
  const sessions: SessionMap = {}
  const requiredRoles = definition.sessions.roles ?? []

  const hydrateSessionForRole = async (role: string, nameTemplate?: string): Promise<Session> => {
    const renderContext = { runId }
    const name = nameTemplate ? renderSimpleTemplate(nameTemplate, renderContext) : undefined
    return createSession(directory, name ? { name } : {})
  }

  if (!hasRunMeta(runId, directory)) {
    const createdAgents: { role: string; sessionId: string }[] = []
    for (const roleConfig of requiredRoles) {
      const session = await hydrateSessionForRole(roleConfig.role, roleConfig.nameTemplate)
      createdAgents.push({ role: roleConfig.role, sessionId: session.id })
      sessions[roleConfig.role] = session
    }
    const runMeta = createRunMeta(directory, runId, createdAgents, metaExtras)
    saveRunMeta(runMeta, runId, directory)
    return sessions
  }

  const meta = loadRunMeta(runId, directory)

  for (const roleConfig of requiredRoles) {
    const existing = meta.agents.find((agent) => agent.role === roleConfig.role)
    let session: Session | null = null
    if (existing?.sessionId) {
      session = await getSession(directory, existing.sessionId)
    }
    if (!session) {
      session = await hydrateSessionForRole(roleConfig.role, roleConfig.nameTemplate)
      const agentEntry = meta.agents.find((agent) => agent.role === roleConfig.role)
      if (agentEntry) {
        agentEntry.sessionId = session.id
      } else {
        meta.agents.push({ role: roleConfig.role, sessionId: session.id })
      }
      saveRunMeta(meta, runId, directory)
    }
    sessions[roleConfig.role] = session
  }

  return sessions
}

type StepDictionary<TDefinition extends AgentWorkflowDefinition> = Partial<{
  [Key in RoundStepKey<TDefinition>]: WorkflowTurnForStep<TDefinition, StepDefinitionByKey<TDefinition, Key>>
}>

type TemplateScope<TDefinition extends AgentWorkflowDefinition> = {
  user: Record<string, unknown>
  run: { id: string }
  state: Record<string, string>
  steps: StepDictionary<TDefinition>
  bootstrap?: BootstrapTurn<TDefinition>
  round: number
  maxRounds: number
}

type StepAwareScope<TDefinition extends AgentWorkflowDefinition> = TemplateScope<TDefinition> & {
  current?: AnyWorkflowTurn<TDefinition>
  parsed?: AnyWorkflowTurn<TDefinition>['parsed']
  raw?: string
}

const cloneScope = <TDefinition extends AgentWorkflowDefinition>(
  scope: TemplateScope<TDefinition>,
  additions: Partial<TemplateScope<TDefinition>> = {}
): TemplateScope<TDefinition> => ({
  user: scope.user,
  run: scope.run,
  state: scope.state,
  steps: scope.steps,
  bootstrap: scope.bootstrap,
  round: scope.round,
  maxRounds: scope.maxRounds,
  ...additions
})

const scopeWithStep = <TDefinition extends AgentWorkflowDefinition>(
  scope: TemplateScope<TDefinition>,
  step: AnyWorkflowTurn<TDefinition>
): StepAwareScope<TDefinition> => ({
  ...scope,
  current: step,
  parsed: step.parsed,
  raw: step.raw
})

const getValueAtPath = (source: any, pathExpression: string): any => {
  if (!pathExpression) return undefined
  const parts = pathExpression
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean)
  let current: any = source
  for (const part of parts) {
    if (current == null) {
      return undefined
    }
    current = current[part]
  }
  return current
}

const evaluateExpression = <TDefinition extends AgentWorkflowDefinition>(
  expression: string,
  scope: StepAwareScope<TDefinition> | TemplateScope<TDefinition>
): string => {
  const fallbacks = expression.split('||').map((segment) => segment.trim())
  for (const segment of fallbacks) {
    if (!segment) continue
    const isQuoted =
      (segment.startsWith('"') && segment.endsWith('"')) || (segment.startsWith("'") && segment.endsWith("'"))
    if (isQuoted) {
      const literal = segment.slice(1, -1)
      if (literal.length > 0) {
        return literal
      }
      continue
    }
    const pathExpression = segment.startsWith('@') ? segment.slice(1) : segment
    const value = getValueAtPath(scope, pathExpression)
    if (value === undefined || value === null) {
      continue
    }
    if (typeof value === 'string') {
      if (value.length === 0) continue
      return value
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value)
    }
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value)
      } catch {}
    }
  }
  return ''
}

const renderTemplateString = <TDefinition extends AgentWorkflowDefinition>(
  template: string,
  scope: StepAwareScope<TDefinition> | TemplateScope<TDefinition>
): string => {
  return template.replace(/{{\s*([^}]+)\s*}}/g, (_, expr: string) => evaluateExpression(expr, scope))
}

const renderPrompt = <TDefinition extends AgentWorkflowDefinition>(
  sections: ReadonlyArray<string>,
  scope: TemplateScope<TDefinition>
): string => {
  return sections
    .map((section) => renderTemplateString(section, scope).trim())
    .filter(Boolean)
    .join('\n\n')
}

const initializeState = <TDefinition extends AgentWorkflowDefinition>(
  initial: Record<string, string> | undefined,
  scope: TemplateScope<TDefinition>
): Record<string, string> => {
  if (!initial) return {}
  const state: Record<string, string> = {}
  for (const [key, value] of Object.entries(initial) as Array<[string, string]>) {
    const scoped = cloneScope(scope, { state })
    state[key] = renderTemplateString(value, scoped)
  }
  return state
}

const initializeUserInputs = <TDefinition extends AgentWorkflowDefinition>(
  userDefs: Record<string, WorkflowParserJsonSchema> | undefined,
  scope: TemplateScope<TDefinition>
): Record<string, unknown> => {
  if (!userDefs) return {}
  const user: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(userDefs) as Array<[string, WorkflowParserJsonSchema]>) {
    try {
      const parser = workflowParserSchemaToZod(schema as any)
      // If the schema provides a default, parsing `undefined` will yield it.
      const parsed = parser.parse(undefined)
      if (parsed !== undefined) {
        user[key] = parsed
      }
    } catch {
      // No default or parsing failed; leave undefined
    }
  }
  return user
}

type StepExecutionContext<TDefinition extends AgentWorkflowDefinition> = {
  definition: TDefinition
  sessions: SessionMap
  model: string
  directory: string
  runId: string
  onStream?: AgentStreamCallback
}

const executeStep = async <TDefinition extends AgentWorkflowDefinition, TStep extends WorkflowStepDefinition>(
  step: TStep,
  scope: TemplateScope<TDefinition>,
  ctx: StepExecutionContext<TDefinition>
): Promise<WorkflowTurnForStep<TDefinition, TStep>> => {
  const roleConfig = ctx.definition.roles[step.role]
  if (!roleConfig) {
    throw new Error(`Workflow step ${step.role} missing role configuration.`)
  }
  const session = ctx.sessions[step.role]
  if (!session) {
    throw new Error(`No session available for role ${step.role}`)
  }
  const prompt = renderPrompt(step.prompt, scope)
  const parserDefinition = ctx.definition.parsers?.[roleConfig.parser]
  if (!parserDefinition) {
    throw new Error(
      `Parser '${roleConfig.parser}' for role '${step.role}' is not defined in workflow '${ctx.definition.id}'.`
    )
  }
  const parserSchema = workflowParserSchemaToZod(parserDefinition as WorkflowParserJsonSchema)
  const parser = parseJsonPayload(step.role, roleConfig.parser, parserSchema)
  const { raw, parsed } = await invokeStructuredJsonCall({
    step: step.key,
    role: step.role,
    systemPrompt: roleConfig.systemPrompt,
    basePrompt: prompt,
    model: ctx.model,
    session,
    runId: ctx.runId,
    directory: ctx.directory,
    onStream: ctx.onStream,
    parseResponse: parser
  })
  return {
    key: step.key,
    role: step.role,
    round: scope.round,
    raw,
    parsed
  } as WorkflowTurnForStep<TDefinition, TStep>
}

const applyStateUpdates = <TDefinition extends AgentWorkflowDefinition>(
  updates: Record<string, string> | undefined,
  scope: StepAwareScope<TDefinition>,
  state: Record<string, string>
) => {
  if (!updates) return
  for (const [key, template] of Object.entries(updates)) {
    const rendered = renderTemplateString(template, scope)
    state[key] = rendered
  }
}

type RoundNavigator<TDefinition extends AgentWorkflowDefinition> = {
  start: RoundStepKey<TDefinition>
  fallbackNext: Map<RoundStepKey<TDefinition>, RoundStepKey<TDefinition> | undefined>
  stepMap: Map<RoundStepKey<TDefinition>, RoundStepDefinition<TDefinition>>
}

const createRoundNavigator = <TDefinition extends AgentWorkflowDefinition>(
  round: TDefinition['flow']['round']
): RoundNavigator<TDefinition> => {
  const stepMap = new Map<RoundStepKey<TDefinition>, RoundStepDefinition<TDefinition>>()
  const fallbackNext = new Map<RoundStepKey<TDefinition>, RoundStepKey<TDefinition> | undefined>()
  round.steps.forEach((step, index) => {
    const key = step.key as RoundStepKey<TDefinition>
    stepMap.set(key, step)
    const fallback = round.steps[index + 1]?.key as RoundStepKey<TDefinition> | undefined
    fallbackNext.set(key, (step.next as RoundStepKey<TDefinition> | undefined) ?? fallback)
  })
  const startKey = (round.start ?? round.steps[0]?.key) as RoundStepKey<TDefinition> | undefined
  if (!startKey) {
    throw new Error('Workflow round must define at least one step.')
  }
  return { start: startKey, fallbackNext, stepMap }
}

type TransitionResolution<TDefinition extends AgentWorkflowDefinition> =
  | { type: 'outcome'; outcome: WorkflowOutcomeTemplate; stateUpdates?: Record<string, string> }
  | { type: 'next'; nextStep: RoundStepKey<TDefinition>; stateUpdates?: Record<string, string> }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isAnyCondition = (condition: WorkflowCondition): condition is { any: WorkflowCondition[] } =>
  isRecord(condition) && Array.isArray((condition as { any?: unknown }).any)

const isAllCondition = (condition: WorkflowCondition): condition is { all: WorkflowCondition[] } =>
  isRecord(condition) && Array.isArray((condition as { all?: unknown }).all)

const isFieldCondition = (condition: WorkflowCondition): condition is WorkflowFieldCondition =>
  isRecord(condition) &&
  typeof (condition as WorkflowFieldCondition).field === 'string' &&
  !('any' in condition) &&
  !('all' in condition)

const normalizeString = (value: string, caseSensitive?: boolean): string =>
  caseSensitive ? value : value.toLowerCase()

const toStringValue = (value: unknown): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return null
}

const compareEquality = (actual: unknown, expected: string | number | boolean, caseSensitive?: boolean): boolean => {
  if (typeof expected === 'number') {
    const numericActual = typeof actual === 'number' ? actual : typeof actual === 'string' ? Number(actual) : NaN
    return Number.isFinite(numericActual) && numericActual === expected
  }
  if (typeof expected === 'boolean') {
    if (typeof actual === 'boolean') {
      return actual === expected
    }
    if (typeof actual === 'string') {
      const normalizedActual = actual.trim().toLowerCase()
      if (normalizedActual === 'true') return expected === true
      if (normalizedActual === 'false') return expected === false
    }
    return false
  }
  const actualString = toStringValue(actual)
  if (actualString === null) return false
  return normalizeString(actualString, caseSensitive) === normalizeString(expected, caseSensitive)
}

const valueIncludesString = (actual: unknown, needle: string, caseSensitive?: boolean): boolean => {
  const actualString = toStringValue(actual)
  if (actualString === null) return false
  return normalizeString(actualString, caseSensitive).includes(normalizeString(needle, caseSensitive))
}

const valueInList = (
  actual: unknown,
  list: ReadonlyArray<string | number | boolean>,
  caseSensitive?: boolean
): boolean => list.some((candidate) => compareEquality(actual, candidate, caseSensitive))

const valueMatchesPattern = (actual: unknown, pattern: string, caseSensitive?: boolean): boolean => {
  const actualString = toStringValue(actual)
  if (actualString === null) return false
  try {
    const regex = new RegExp(pattern, caseSensitive ? undefined : 'i')
    return regex.test(actualString)
  } catch {
    return false
  }
}

const evaluateFieldCondition = <TDefinition extends AgentWorkflowDefinition>(
  condition: WorkflowFieldCondition,
  scope: StepAwareScope<TDefinition>,
  step: AnyWorkflowTurn<TDefinition>
): boolean => {
  const targetBase = condition.field.startsWith('@') ? scope : step
  const expression = condition.field.startsWith('@') ? condition.field.slice(1) : condition.field
  const value = getValueAtPath(targetBase, expression)

  if (condition.exists !== undefined) {
    const exists = value !== undefined && value !== null && !(typeof value === 'string' && value.length === 0)
    if (condition.exists !== exists) {
      return false
    }
  }

  if (condition.equals !== undefined && !compareEquality(value, condition.equals, condition.caseSensitive)) {
    return false
  }

  if (condition.notEquals !== undefined && compareEquality(value, condition.notEquals, condition.caseSensitive)) {
    return false
  }

  if (condition.includes !== undefined && !valueIncludesString(value, condition.includes, condition.caseSensitive)) {
    return false
  }

  if (condition.in && !valueInList(value, condition.in, condition.caseSensitive)) {
    return false
  }

  if (condition.notIn && valueInList(value, condition.notIn, condition.caseSensitive)) {
    return false
  }

  if (condition.matches && !valueMatchesPattern(value, condition.matches, condition.caseSensitive)) {
    return false
  }

  return true
}

const matchesCondition = <TDefinition extends AgentWorkflowDefinition>(
  condition: WorkflowCondition,
  scope: StepAwareScope<TDefinition>,
  step: AnyWorkflowTurn<TDefinition>
): boolean => {
  if (condition === 'always') return true
  if (isAnyCondition(condition)) {
    return condition.any.some((child) => matchesCondition(child, scope, step))
  }
  if (isAllCondition(condition)) {
    return condition.all.every((child) => matchesCondition(child, scope, step))
  }
  if (isFieldCondition(condition)) {
    return evaluateFieldCondition(condition, scope, step)
  }
  return false
}

const resolveTransition = <TDefinition extends AgentWorkflowDefinition>(
  transitions: ReadonlyArray<WorkflowTransitionDefinition> | undefined,
  stepScope: StepAwareScope<TDefinition>
): TransitionResolution<TDefinition> | null => {
  if (!transitions?.length) return null
  for (const transition of transitions) {
    if (!matchesCondition(transition.condition, stepScope, stepScope.current!)) {
      continue
    }
    const updates = transition.stateUpdates
    if (transition.outcome) {
      return {
        type: 'outcome',
        outcome: {
          outcome: transition.outcome,
          reason: renderTemplateString(transition.reason ?? transition.outcome, stepScope)
        },
        stateUpdates: updates
      }
    }
    if (transition.nextStep) {
      return {
        type: 'next',
        nextStep: transition.nextStep as RoundStepKey<TDefinition>,
        stateUpdates: updates
      }
    }
  }
  return null
}

export async function runAgentWorkflow<TDefinition extends AgentWorkflowDefinition>(
  definition: TDefinition,
  options: AgentWorkflowRunOptions<TDefinition>
): Promise<AgentRunResponse<AgentWorkflowResult<TDefinition>>> {
  if (!options.sessionDir) {
    throw new Error('sessionDir is required for runAgentWorkflow')
  }
  const directory = options.sessionDir
  const model = options.model ?? definition.model ?? 'llama3.2'
  const definitionMaxRounds = definition.flow.round.maxRounds ?? 10
  const maxRounds = options.maxRounds ?? definitionMaxRounds
  const runId = options.runID ?? `${definition.id}-${Date.now()}`
  const sessions = await ensureWorkflowSessions(definition, runId, directory, {
    workflowId: options.workflowId ?? definition.id,
    workflowSource: options.workflowSource,
    workflowLabel: options.workflowLabel ?? definition.description
  })
  // Record provided user inputs (structured object required)
  const userPayload = options.user
  recordUserMessage(runId, directory, userPayload, {
    workflowId: options.workflowId ?? definition.id,
    workflowSource: options.workflowSource ?? 'builtin'
  })

  const resultPromise = (async (): Promise<AgentWorkflowResult<TDefinition>> => {
    const state: Record<string, string> = {}
    // create a baseScope with an empty user map so templating can render user defaults
    const baseScope: TemplateScope<TDefinition> = {
      user: {},
      run: { id: runId },
      state,
      steps: {} as StepDictionary<TDefinition>,
      round: 0,
      maxRounds,
      bootstrap: undefined
    }

    // initialize user inputs from workflow definition, then overlay runtime inputs
    const initializedUser = initializeUserInputs<TDefinition>(definition.user as any, baseScope)

    // If workflow declares a `user` schema, build a Zod parser to validate
    // runtime-provided `options.user`. Use `.partial()` so callers may omit
    // fields; defaults declared in schema will be applied by the individual
    // parsers when parsing undefined.
    let validatedRuntimeUser: Record<string, unknown> = {}
    if (definition.user && Object.keys(definition.user).length > 0) {
      const shape: Record<string, z.ZodTypeAny> = {}
      for (const [key, schema] of Object.entries(definition.user as Record<string, WorkflowParserJsonSchema>)) {
        shape[key] = workflowParserSchemaToZod(schema as WorkflowParserJsonSchema)
      }
      const userParser = z.object(shape)
      try {
        validatedRuntimeUser = userParser.parse(options.user ?? {})
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`Invalid user inputs for workflow ${definition.id}: ${message}`)
      }
    } else {
      validatedRuntimeUser = options.user ?? {}
    }

    baseScope.user = { ...initializedUser, ...validatedRuntimeUser }

    const initializedState = initializeState<TDefinition>(definition.state?.initial, baseScope)
    Object.assign(state, initializedState)

    const execCtx: StepExecutionContext<TDefinition> = {
      definition,
      sessions,
      model,
      directory,
      runId,
      onStream: options.onStream
    }

    let bootstrapTurn: BootstrapTurn<TDefinition> | undefined
    if (definition.flow.bootstrap) {
      const bootstrapScope = cloneScope(baseScope, { round: 0, steps: {} as StepDictionary<TDefinition> })
      const bootstrapDefinition = definition.flow.bootstrap as BootstrapStepDefinition<TDefinition>
      const executedBootstrap = (await executeStep(
        bootstrapDefinition,
        bootstrapScope,
        execCtx
      )) as BootstrapTurn<TDefinition>
      bootstrapTurn = executedBootstrap
      baseScope.bootstrap = executedBootstrap
      const bootstrapStepScope = scopeWithStep(bootstrapScope, executedBootstrap)
      applyStateUpdates(definition.flow.bootstrap.stateUpdates, bootstrapStepScope, state)
    }

    const rounds: AgentWorkflowRound<TDefinition>[] = []
    let finalOutcome: WorkflowOutcomeTemplate | null = null
    const roundDefinition = definition.flow.round
    const navigator = createRoundNavigator(definition.flow.round)
    const maxStepIterations = Math.max(roundDefinition.steps.length * 3, roundDefinition.steps.length + 1)

    for (let roundNumber = 1; roundNumber <= maxRounds && !finalOutcome; roundNumber++) {
      const roundSteps: StepDictionary<TDefinition> = {}
      const roundScope = cloneScope(baseScope, { round: roundNumber, steps: roundSteps })
      let currentStepKey: RoundStepKey<TDefinition> | undefined = navigator.start
      let stepIterations = 0

      while (currentStepKey && !finalOutcome) {
        stepIterations += 1
        if (stepIterations > maxStepIterations) {
          throw new Error(
            `Workflow transitions exceeded safe limit in round ${roundNumber}. Check for cycles in ${definition.id}.`
          )
        }

        const stepDefinition = navigator.stepMap.get(currentStepKey)
        if (!stepDefinition) {
          throw new Error(`Workflow step ${currentStepKey} not found in definition ${definition.id}`)
        }

        const stepResult = (await executeStep(stepDefinition, roundScope, execCtx)) as RoundStepTurn<TDefinition>
        const stepKey = stepDefinition.key as RoundStepKey<TDefinition>
        roundSteps[stepKey] = stepResult
        const currentScope = scopeWithStep(roundScope, stepResult)

        applyStateUpdates(stepDefinition.stateUpdates, currentScope, state)

        const transitionResolution = resolveTransition(stepDefinition.transitions, currentScope)
        if (transitionResolution) {
          applyStateUpdates(transitionResolution.stateUpdates, currentScope, state)
          if (transitionResolution.type === 'outcome') {
            finalOutcome = transitionResolution.outcome
            break
          }
          currentStepKey = transitionResolution.nextStep
          continue
        }

        const exitResolution = resolveTransition(stepDefinition.exits, currentScope)
        if (exitResolution) {
          applyStateUpdates(exitResolution.stateUpdates, currentScope, state)
          if (exitResolution.type === 'outcome') {
            finalOutcome = exitResolution.outcome
            break
          }
          currentStepKey = exitResolution.nextStep
          continue
        }

        currentStepKey = navigator.fallbackNext.get(stepDefinition.key)
      }
      const finalizedSteps: StepDictionary<TDefinition> = { ...roundSteps }
      rounds.push({ round: roundNumber, steps: finalizedSteps })
    }

    if (!finalOutcome) {
      finalOutcome = {
        outcome: definition.flow.round.defaultOutcome.outcome,
        reason: renderTemplateString(definition.flow.round.defaultOutcome.reason, baseScope)
      }
    }

    return {
      outcome: finalOutcome.outcome,
      reason: finalOutcome.reason,
      bootstrap: bootstrapTurn,
      rounds
    }
  })()

  return { runId, result: resultPromise }
}

export async function getWorkflowRunDiff(
  runId: string,
  directory: string,
  options: { role?: string; messageId?: string } = {}
): Promise<FileDiff[]> {
  if (!directory) throw new Error('sessionDir is required for getWorkflowRunDiff')
  const meta = loadRunMeta(runId, directory)
  const targetRole = options.role ?? meta.agents[0]?.role
  if (!targetRole) {
    throw new Error(`No agent roles recorded for run ${runId}`)
  }
  const logDiff = findLatestRoleDiff(meta, targetRole)
  if (logDiff?.length) {
    return logDiff
  }
  const agentEntry = meta.agents.find((agent) => agent.role === targetRole)
  if (!agentEntry) {
    throw new Error(`Role ${targetRole} not found in run meta`)
  }
  const session = await getSession(directory, agentEntry.sessionId)
  if (!session) {
    throw new Error(`Session not found for role ${targetRole}`)
  }
  const messageId = options.messageId ?? findLatestRoleMessageId(meta, targetRole)
  if (!messageId) return []
  const opencodeDiffs = await getMessageDiff(session, messageId)
  if (opencodeDiffs.length > 0) {
    return opencodeDiffs
  }
  return []
}
