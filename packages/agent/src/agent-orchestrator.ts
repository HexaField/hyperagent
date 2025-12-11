import type { FileDiff, Session } from '@opencode-ai/sdk'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  AgentRunResponse,
  AgentStreamCallback,
  invokeStructuredJsonCall,
  parseJsonPayload,
  type WorkflowParserOutput,
  type WorkflowParserRegistry
} from './agent'
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
  type WorkflowParserJsonOutput,
  type WorkflowParserJsonSchema
} from './workflow-schema'

export type AgentWorkflowRunOptions = {
  userInstructions: string
  sessionDir: string
  model?: string
  runID?: string
  maxRounds?: number
  onStream?: AgentStreamCallback
  workflowId?: string
  workflowSource?: 'builtin' | 'user'
  workflowLabel?: string
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

type ParserForRole<
  TDefinition extends AgentWorkflowDefinition,
  Role extends WorkflowRoleName<TDefinition>,
  TParsers extends WorkflowParserRegistry
> = ParserLookup<TDefinition>[Role] & (keyof NonNullable<TDefinition['parsers']> & keyof TParsers & string)

type ParserOutputForRole<
  TDefinition extends AgentWorkflowDefinition,
  Role extends WorkflowRoleName<TDefinition>,
  TParsers extends WorkflowParserRegistry
> =
  ParserSchemaForRole<TDefinition, Role> extends WorkflowParserJsonSchema
    ? WorkflowParserJsonOutput<ParserSchemaForRole<TDefinition, Role>>
    : ParserForRole<TDefinition, Role, TParsers> extends never
      ? never
      : WorkflowParserOutput<TParsers, ParserForRole<TDefinition, Role, TParsers>>

type WorkflowTurnForStep<
  TDefinition extends AgentWorkflowDefinition,
  TStep extends WorkflowStepDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
> = TStep extends WorkflowStepDefinition
  ? {
      key: TStep['key']
      role: TStep['role']
      round: number
      raw: string
      parsed: ParserOutputForRole<TDefinition, TStep['role'] & WorkflowRoleName<TDefinition>, TParsers>
    }
  : never

type RoundStepTurn<
  TDefinition extends AgentWorkflowDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
> = WorkflowTurnForStep<TDefinition, RoundStepDefinition<TDefinition>, TParsers>

type BootstrapTurn<
  TDefinition extends AgentWorkflowDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
> = WorkflowTurnForStep<TDefinition, BootstrapStepDefinition<TDefinition>, TParsers>

type AnyWorkflowTurn<
  TDefinition extends AgentWorkflowDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
> = RoundStepTurn<TDefinition, TParsers> | BootstrapTurn<TDefinition, TParsers>

export type AgentWorkflowTurn<
  TDefinition extends AgentWorkflowDefinition = AgentWorkflowDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
> = RoundStepTurn<TDefinition, TParsers> | BootstrapTurn<TDefinition, TParsers>

export type AgentWorkflowRound<
  TDefinition extends AgentWorkflowDefinition = AgentWorkflowDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
> = {
  round: number
  steps: StepDictionary<TDefinition, TParsers>
}

export type AgentWorkflowResult<
  TDefinition extends AgentWorkflowDefinition = AgentWorkflowDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
> = {
  outcome: string
  reason: string
  bootstrap?: BootstrapTurn<TDefinition, TParsers>
  rounds: Array<AgentWorkflowRound<TDefinition, TParsers>>
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

type StepDictionary<
  TDefinition extends AgentWorkflowDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
> = Partial<{
  [Key in RoundStepKey<TDefinition>]: WorkflowTurnForStep<TDefinition, StepDefinitionByKey<TDefinition, Key>, TParsers>
}>

type TemplateScope<
  TDefinition extends AgentWorkflowDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
> = {
  user: { instructions: string }
  run: { id: string }
  state: Record<string, string>
  steps: StepDictionary<TDefinition, TParsers>
  bootstrap?: BootstrapTurn<TDefinition, TParsers>
  round: number
  maxRounds: number
}

type StepAwareScope<
  TDefinition extends AgentWorkflowDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
> = TemplateScope<TDefinition, TParsers> & {
  current?: AnyWorkflowTurn<TDefinition, TParsers>
  parsed?: AnyWorkflowTurn<TDefinition, TParsers>['parsed']
  raw?: string
}

const cloneScope = <
  TDefinition extends AgentWorkflowDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
>(
  scope: TemplateScope<TDefinition, TParsers>,
  additions: Partial<TemplateScope<TDefinition, TParsers>> = {}
): TemplateScope<TDefinition, TParsers> => ({
  user: scope.user,
  run: scope.run,
  state: scope.state,
  steps: scope.steps,
  bootstrap: scope.bootstrap,
  round: scope.round,
  maxRounds: scope.maxRounds,
  ...additions
})

const scopeWithStep = <
  TDefinition extends AgentWorkflowDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
>(
  scope: TemplateScope<TDefinition, TParsers>,
  step: AnyWorkflowTurn<TDefinition, TParsers>
): StepAwareScope<TDefinition, TParsers> => ({
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

const evaluateExpression = <
  TDefinition extends AgentWorkflowDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
>(
  expression: string,
  scope: StepAwareScope<TDefinition, TParsers> | TemplateScope<TDefinition, TParsers>
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

const renderTemplateString = <
  TDefinition extends AgentWorkflowDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
>(
  template: string,
  scope: StepAwareScope<TDefinition, TParsers> | TemplateScope<TDefinition, TParsers>
): string => {
  return template.replace(/{{\s*([^}]+)\s*}}/g, (_, expr: string) => evaluateExpression(expr, scope))
}

const renderPrompt = <
  TDefinition extends AgentWorkflowDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
>(
  sections: ReadonlyArray<string>,
  scope: TemplateScope<TDefinition, TParsers>
): string => {
  return sections
    .map((section) => renderTemplateString(section, scope).trim())
    .filter(Boolean)
    .join('\n\n')
}

const initializeState = <
  TDefinition extends AgentWorkflowDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
>(
  initial: Record<string, string> | undefined,
  scope: TemplateScope<TDefinition, TParsers>
): Record<string, string> => {
  if (!initial) return {}
  const state: Record<string, string> = {}
  for (const [key, value] of Object.entries(initial) as Array<[string, string]>) {
    const scoped = cloneScope(scope, { state })
    state[key] = renderTemplateString(value, scoped)
  }
  return state
}

type StepExecutionContext<TDefinition extends AgentWorkflowDefinition> = {
  definition: TDefinition
  sessions: SessionMap
  model: string
  directory: string
  runId: string
  onStream?: AgentStreamCallback
}

const executeStep = async <
  TDefinition extends AgentWorkflowDefinition,
  TStep extends WorkflowStepDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
>(
  step: TStep,
  scope: TemplateScope<TDefinition, TParsers>,
  ctx: StepExecutionContext<TDefinition>
): Promise<WorkflowTurnForStep<TDefinition, TStep, TParsers>> => {
  const roleConfig = ctx.definition.roles[step.key]
  if (!roleConfig) {
    throw new Error(`Workflow role ${step.role} missing definition`)
  }
  const session = ctx.sessions[step.role]
  if (!session) {
    throw new Error(`No session available for role ${step.role}`)
  }
  const prompt = renderPrompt(step.prompt, scope)
  const parser = parseJsonPayload(step.role, roleConfig.parser)
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
    parseResponse: (response) => parser(step.role, response)
  })
  return {
    key: step.key,
    role: step.role,
    round: scope.round,
    raw,
    parsed
  } as WorkflowTurnForStep<TDefinition, TStep, TParsers>
}

const applyStateUpdates = <
  TDefinition extends AgentWorkflowDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
>(
  updates: Record<string, string> | undefined,
  scope: StepAwareScope<TDefinition, TParsers>,
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

const evaluateFieldCondition = <
  TDefinition extends AgentWorkflowDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
>(
  condition: WorkflowFieldCondition,
  scope: StepAwareScope<TDefinition, TParsers>,
  step: AnyWorkflowTurn<TDefinition, TParsers>
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

const matchesCondition = <
  TDefinition extends AgentWorkflowDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
>(
  condition: WorkflowCondition,
  scope: StepAwareScope<TDefinition, TParsers>,
  step: AnyWorkflowTurn<TDefinition, TParsers>
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

const resolveTransition = <
  TDefinition extends AgentWorkflowDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
>(
  transitions: ReadonlyArray<WorkflowTransitionDefinition> | undefined,
  stepScope: StepAwareScope<TDefinition, TParsers>
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

export async function runAgentWorkflow<
  TDefinition extends AgentWorkflowDefinition,
  TParsers extends WorkflowParserRegistry = WorkflowParserRegistry
>(
  definition: TDefinition,
  options: AgentWorkflowRunOptions
): Promise<AgentRunResponse<AgentWorkflowResult<TDefinition, TParsers>>> {
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
  recordUserMessage(runId, directory, options.userInstructions, {
    workflowId: options.workflowId ?? definition.id,
    workflowSource: options.workflowSource ?? 'builtin'
  })

  const resultPromise = (async (): Promise<AgentWorkflowResult<TDefinition, TParsers>> => {
    const state: Record<string, string> = {}
    const baseScope: TemplateScope<TDefinition, TParsers> = {
      user: { instructions: options.userInstructions },
      run: { id: runId },
      state,
      steps: {} as StepDictionary<TDefinition, TParsers>,
      round: 0,
      maxRounds,
      bootstrap: undefined
    }
    const initializedState = initializeState<TDefinition, TParsers>(definition.state?.initial, baseScope)
    Object.assign(state, initializedState)

    const execCtx: StepExecutionContext<TDefinition> = {
      definition,
      sessions,
      model,
      directory,
      runId,
      onStream: options.onStream
    }

    let bootstrapTurn: BootstrapTurn<TDefinition, TParsers> | undefined
    if (definition.flow.bootstrap) {
      const bootstrapScope = cloneScope(baseScope, { round: 0, steps: {} as StepDictionary<TDefinition, TParsers> })
      const bootstrapDefinition = definition.flow.bootstrap as BootstrapStepDefinition<TDefinition>
      const executedBootstrap = (await executeStep(bootstrapDefinition, bootstrapScope, execCtx)) as BootstrapTurn<
        TDefinition,
        TParsers
      >
      bootstrapTurn = executedBootstrap
      baseScope.bootstrap = executedBootstrap
      const bootstrapStepScope = scopeWithStep(bootstrapScope, executedBootstrap)
      applyStateUpdates(definition.flow.bootstrap.stateUpdates, bootstrapStepScope, state)
    }

    const rounds: AgentWorkflowRound<TDefinition, TParsers>[] = []
    let finalOutcome: WorkflowOutcomeTemplate | null = null
    const roundDefinition = definition.flow.round
    const navigator = createRoundNavigator(definition.flow.round)
    const maxStepIterations = Math.max(roundDefinition.steps.length * 3, roundDefinition.steps.length + 1)

    for (let roundNumber = 1; roundNumber <= maxRounds && !finalOutcome; roundNumber++) {
      const roundSteps: StepDictionary<TDefinition, TParsers> = {}
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

        const stepResult = (await executeStep(stepDefinition, roundScope, execCtx)) as RoundStepTurn<
          TDefinition,
          TParsers
        >
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
      const finalizedSteps: StepDictionary<TDefinition, TParsers> = { ...roundSteps }
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
