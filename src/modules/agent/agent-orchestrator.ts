import type { FileDiff, Session } from '@opencode-ai/sdk'
import fs from 'fs'
import path from 'path'
import {
  createRunMeta,
  findLatestRoleDiff,
  findLatestRoleMessageId,
  hasRunMeta,
  loadRunMeta,
  recordUserMessage,
  saveRunMeta
} from '../provenance/provenance'
import {
  AgentRunResponse,
  AgentStreamCallback,
  coerceString,
  invokeStructuredJsonCall,
  parseJsonPayload
} from './agent'
import { createSession, getSession, getSessionDiff } from './opencode'
import {
  AgentWorkflowDefinition,
  WorkflowCondition,
  WorkflowFieldCondition,
  WorkflowOutcomeTemplate,
  WorkflowRoleParser,
  WorkflowStepDefinition,
  WorkflowTransitionDefinition,
  workflowDefinitionSchema
} from './workflow-schema'

export type WorkerStructuredResponse = {
  status: 'working' | 'done' | 'blocked'
  plan: string
  work: string
  requests: string
}

export type VerifierStructuredResponse = {
  verdict: 'instruct' | 'approve' | 'fail'
  critique: string
  instructions: string
  priority: number
}

export type AgentWorkflowRunOptions = {
  userInstructions: string
  sessionDir: string
  model?: string
  runID?: string
  maxRounds?: number
  onStream?: AgentStreamCallback
}

type ParserOutputMap = {
  worker: WorkerStructuredResponse
  verifier: VerifierStructuredResponse
  passthrough: unknown
}

export type WorkflowRoleName<TDefinition extends AgentWorkflowDefinition> = keyof TDefinition['roles'] & string

type ParserLookup<TDefinition extends AgentWorkflowDefinition> = {
  [Role in WorkflowRoleName<TDefinition>]: TDefinition['roles'][Role]['parser']
}

type RoundStepDefinition<TDefinition extends AgentWorkflowDefinition> = TDefinition['flow']['round']['steps'][number]
type RoundStepKey<TDefinition extends AgentWorkflowDefinition> = RoundStepDefinition<TDefinition>['key']
type BootstrapStepDefinition<TDefinition extends AgentWorkflowDefinition> =
  TDefinition['flow']['bootstrap'] extends WorkflowStepDefinition ? TDefinition['flow']['bootstrap'] : never

type ParserForRole<
  TDefinition extends AgentWorkflowDefinition,
  Role extends WorkflowRoleName<TDefinition>
> = ParserLookup<TDefinition>[Role]

type ParserOutputForRole<
  TDefinition extends AgentWorkflowDefinition,
  Role extends WorkflowRoleName<TDefinition>
> = ParserOutputMap[ParserForRole<TDefinition, Role>]

type RoundStepTurn<TDefinition extends AgentWorkflowDefinition> =
  RoundStepDefinition<TDefinition> extends infer Step
    ? Step extends WorkflowStepDefinition
      ? {
          key: Step['key']
          role: Step['role']
          round: number
          raw: string
          parsed: ParserOutputForRole<TDefinition, Step['role'] & WorkflowRoleName<TDefinition>>
        }
      : never
    : never

type BootstrapTurn<TDefinition extends AgentWorkflowDefinition> =
  BootstrapStepDefinition<TDefinition> extends infer Step
    ? Step extends WorkflowStepDefinition
      ? {
          key: Step['key']
          role: Step['role']
          round: number
          raw: string
          parsed: ParserOutputForRole<TDefinition, Step['role'] & WorkflowRoleName<TDefinition>>
        }
      : never
    : never

export type AgentWorkflowTurn<TDefinition extends AgentWorkflowDefinition = AgentWorkflowDefinition> =
  | RoundStepTurn<TDefinition>
  | BootstrapTurn<TDefinition>

export type AgentWorkflowRound<TDefinition extends AgentWorkflowDefinition = AgentWorkflowDefinition> = {
  round: number
  steps: Partial<Record<RoundStepKey<TDefinition>, RoundStepTurn<TDefinition>>>
}

export type AgentWorkflowResult<TDefinition extends AgentWorkflowDefinition = AgentWorkflowDefinition> = {
  outcome: string
  reason: string
  bootstrap?: BootstrapTurn<TDefinition>
  rounds: Array<AgentWorkflowRound<TDefinition>>
}

type RuntimeWorkflowTurn = {
  key: string
  role: string
  round: number
  raw: string
  parsed: any
}

type RuntimeWorkflowRound = {
  round: number
  steps: Record<string, RuntimeWorkflowTurn>
}

type RuntimeWorkflowResult = {
  outcome: string
  reason: string
  bootstrap?: RuntimeWorkflowTurn
  rounds: RuntimeWorkflowRound[]
}

export function loadWorkflowDefinition(filePath: string): AgentWorkflowDefinition {
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath)
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
  directory: string
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
    const runMeta = createRunMeta(directory, runId, createdAgents)
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

type TemplateScope = {
  user: { instructions: string }
  run: { id: string }
  state: Record<string, string>
  steps: Record<string, RuntimeWorkflowTurn>
  bootstrap?: RuntimeWorkflowTurn
  round: number
  maxRounds: number
}

type StepAwareScope = TemplateScope & {
  current?: RuntimeWorkflowTurn
  parsed?: any
  raw?: string
}

const cloneScope = (scope: TemplateScope, additions: Partial<TemplateScope> = {}): TemplateScope => ({
  user: scope.user,
  run: scope.run,
  state: scope.state,
  steps: scope.steps,
  bootstrap: scope.bootstrap,
  round: scope.round,
  maxRounds: scope.maxRounds,
  ...additions
})

const scopeWithStep = (scope: TemplateScope, step: RuntimeWorkflowTurn): StepAwareScope => ({
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

const evaluateExpression = (expression: string, scope: StepAwareScope | TemplateScope): string => {
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

const renderTemplateString = (template: string, scope: StepAwareScope | TemplateScope): string => {
  return template.replace(/{{\s*([^}]+)\s*}}/g, (_, expr: string) => evaluateExpression(expr, scope))
}

const renderPrompt = (sections: ReadonlyArray<string>, scope: TemplateScope): string => {
  return sections
    .map((section) => renderTemplateString(section, scope).trim())
    .filter(Boolean)
    .join('\n\n')
}

const initializeState = (initial: Record<string, string> | undefined, scope: TemplateScope): Record<string, string> => {
  if (!initial) return {}
  const state: Record<string, string> = {}
  for (const [key, value] of Object.entries(initial) as Array<[string, string]>) {
    const scoped = cloneScope(scope, { state })
    state[key] = renderTemplateString(value, scoped)
  }
  return state
}

type StepExecutionContext = {
  definition: AgentWorkflowDefinition
  sessions: SessionMap
  model: string
  directory: string
  runId: string
  onStream?: AgentStreamCallback
}

const builtInParsers: Record<WorkflowRoleParser, (role: string, raw: string) => any> = {
  worker: (role, res) => parseWorkerResponse(role, res),
  verifier: (role, res) => parseVerifierResponse(role, res),
  passthrough: (role, res) => parseJsonPayload(role, res)
}

const executeStep = async (
  step: WorkflowStepDefinition,
  scope: TemplateScope,
  ctx: StepExecutionContext
): Promise<RuntimeWorkflowTurn> => {
  const roleConfig = ctx.definition.roles[step.role]
  if (!roleConfig) {
    throw new Error(`Workflow role ${step.role} missing definition`)
  }
  const session = ctx.sessions[step.role]
  if (!session) {
    throw new Error(`No session available for role ${step.role}`)
  }
  const prompt = renderPrompt(step.prompt, scope)
  const parser = builtInParsers[roleConfig.parser]
  const { raw, parsed } = await invokeStructuredJsonCall({
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
  return { key: step.key, role: step.role, round: scope.round, raw, parsed }
}

const applyStateUpdates = (
  updates: Record<string, string> | undefined,
  scope: StepAwareScope,
  state: Record<string, string>
) => {
  if (!updates) return
  for (const [key, template] of Object.entries(updates)) {
    const rendered = renderTemplateString(template, scope)
    state[key] = rendered
  }
}

type RoundNavigator = {
  start: string
  fallbackNext: Map<string, string | undefined>
  stepMap: Map<string, WorkflowStepDefinition>
}

const createRoundNavigator = (round: AgentWorkflowDefinition['flow']['round']): RoundNavigator => {
  const stepMap = new Map<string, WorkflowStepDefinition>()
  const fallbackNext = new Map<string, string | undefined>()
  round.steps.forEach((step, index) => {
    stepMap.set(step.key, step)
    const fallback = round.steps[index + 1]?.key
    fallbackNext.set(step.key, step.next ?? fallback)
  })
  const startKey = round.start ?? round.steps[0]?.key
  if (!startKey) {
    throw new Error('Workflow round must define at least one step.')
  }
  return { start: startKey, fallbackNext, stepMap }
}

type TransitionResolution =
  | { type: 'outcome'; outcome: WorkflowOutcomeTemplate; stateUpdates?: Record<string, string> }
  | { type: 'next'; nextStep: string; stateUpdates?: Record<string, string> }

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

const evaluateFieldCondition = (
  condition: WorkflowFieldCondition,
  scope: StepAwareScope,
  step: RuntimeWorkflowTurn
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

const matchesCondition = (condition: WorkflowCondition, scope: StepAwareScope, step: RuntimeWorkflowTurn): boolean => {
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

const resolveTransition = (
  transitions: ReadonlyArray<WorkflowTransitionDefinition> | undefined,
  stepScope: StepAwareScope
): TransitionResolution | null => {
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
      return { type: 'next', nextStep: transition.nextStep, stateUpdates: updates }
    }
  }
  return null
}

export async function runAgentWorkflow<TDefinition extends AgentWorkflowDefinition>(
  definition: TDefinition,
  options: AgentWorkflowRunOptions
): Promise<AgentRunResponse<AgentWorkflowResult<TDefinition>>> {
  if (!options.sessionDir) {
    throw new Error('sessionDir is required for runAgentWorkflow')
  }
  const directory = options.sessionDir
  const model = options.model ?? definition.model ?? 'llama3.2'
  const definitionMaxRounds = definition.flow.round.maxRounds ?? 10
  const maxRounds = options.maxRounds ?? definitionMaxRounds
  const runId = options.runID ?? `${definition.id}-${Date.now()}`
  const sessions = await ensureWorkflowSessions(definition, runId, directory)
  recordUserMessage(runId, directory, options.userInstructions)

  const resultPromise = (async (): Promise<RuntimeWorkflowResult> => {
    const state: Record<string, string> = {}
    const baseScope: TemplateScope = {
      user: { instructions: options.userInstructions },
      run: { id: runId },
      state,
      steps: {},
      round: 0,
      maxRounds,
      bootstrap: undefined
    }
    const initializedState = initializeState(definition.state?.initial, baseScope)
    Object.assign(state, initializedState)

    const execCtx: StepExecutionContext = {
      definition,
      sessions,
      model,
      directory,
      runId,
      onStream: options.onStream
    }

    let bootstrapTurn: RuntimeWorkflowTurn | undefined
    if (definition.flow.bootstrap) {
      const bootstrapScope = cloneScope(baseScope, { round: 0, steps: {} })
      bootstrapTurn = await executeStep(definition.flow.bootstrap, bootstrapScope, execCtx)
      baseScope.bootstrap = bootstrapTurn
      const bootstrapStepScope = scopeWithStep(bootstrapScope, bootstrapTurn)
      applyStateUpdates(definition.flow.bootstrap.stateUpdates, bootstrapStepScope, state)
    }

    const rounds: RuntimeWorkflowRound[] = []
    let finalOutcome: WorkflowOutcomeTemplate | null = null
    const roundDefinition = definition.flow.round
    const navigator = createRoundNavigator(roundDefinition)
    const maxStepIterations = Math.max(roundDefinition.steps.length * 3, roundDefinition.steps.length + 1)

    for (let roundNumber = 1; roundNumber <= maxRounds && !finalOutcome; roundNumber++) {
      const roundSteps: Record<string, RuntimeWorkflowTurn> = {}
      const roundScope = cloneScope(baseScope, { round: roundNumber, steps: roundSteps })
      let currentStepKey: string | undefined = navigator.start
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

        const stepResult = await executeStep(stepDefinition, roundScope, execCtx)
        roundSteps[stepDefinition.key] = stepResult
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

      rounds.push({ round: roundNumber, steps: { ...roundSteps } })
    }

    if (!finalOutcome) {
      finalOutcome = {
        outcome: definition.flow.round.defaultOutcome.outcome,
        reason: renderTemplateString(definition.flow.round.defaultOutcome.reason, baseScope)
      }
    }

    const runtimeResult: RuntimeWorkflowResult = {
      outcome: finalOutcome.outcome,
      reason: finalOutcome.reason,
      bootstrap: bootstrapTurn,
      rounds
    }
    return runtimeResult
  })()

  return { runId, result: resultPromise as Promise<AgentWorkflowResult<TDefinition>> }
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
  const messageId = options.messageId ?? findLatestRoleMessageId(meta, targetRole) ?? undefined
  const opencodeDiffs = await getSessionDiff(session, messageId)
  if (opencodeDiffs.length > 0) {
    return opencodeDiffs
  }
  return []
}

function normalizeWorkerStatus(value: unknown): 'working' | 'done' | 'blocked' {
  const asString = typeof value === 'string' ? value.toLowerCase() : 'working'
  if (asString === 'done' || asString === 'blocked') {
    return asString
  }
  return 'working'
}

function parseWorkerResponse(role: string, res: string) {
  const obj = parseJsonPayload(role, res)
  const status = normalizeWorkerStatus(obj.status)
  return {
    status,
    plan: coerceString(obj.plan ?? obj.analysis ?? obj.summary ?? obj.work ?? ''),
    work: coerceString(obj.work ?? obj.output ?? obj.result ?? obj.answer ?? ''),
    requests: coerceString(obj.requests ?? obj.questions ?? obj.blockers ?? '')
  }
}

function parseVerifierResponse(role: string, res: string) {
  const obj = parseJsonPayload(role, res)
  const verdictRaw = typeof obj.verdict === 'string' ? obj.verdict.toLowerCase() : coerceString(obj.status, 'instruct')
  const verdict = ['approve', 'fail', 'instruct'].includes(verdictRaw) ? verdictRaw : 'instruct'
  const priority = Number.isInteger(obj.priority) ? obj.priority : 3
  return {
    verdict,
    critique: coerceString(obj.critique ?? obj.feedback ?? ''),
    instructions: coerceString(obj.instructions ?? obj.next_steps ?? obj.plan ?? ''),
    priority: priority as number
  }
}
