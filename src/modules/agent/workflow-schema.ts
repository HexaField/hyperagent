import { z } from 'zod'

type DeepReadonly<T> = T extends (...args: any[]) => any
  ? T
  : T extends Date
    ? T
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T

const conditionValueSchema = z.union([z.string(), z.number(), z.boolean()])

const atomicConditionSchema = z
  .object({
    field: z.string().min(1),
    equals: conditionValueSchema.optional(),
    notEquals: conditionValueSchema.optional(),
    includes: z.string().optional(),
    in: z.array(conditionValueSchema).optional(),
    notIn: z.array(conditionValueSchema).optional(),
    matches: z.string().optional(),
    exists: z.boolean().optional(),
    caseSensitive: z.boolean().optional()
  })
  .refine(
    (condition) =>
      condition.equals !== undefined ||
      condition.notEquals !== undefined ||
      condition.includes !== undefined ||
      condition.in !== undefined ||
      condition.notIn !== undefined ||
      condition.matches !== undefined ||
      condition.exists !== undefined,
    { message: 'At least one comparator must be provided for a field condition.' }
  )

const workflowConditionSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.literal('always'),
    atomicConditionSchema,
    z.object({ any: z.array(workflowConditionSchema).min(1) }),
    z.object({ all: z.array(workflowConditionSchema).min(1) })
  ])
)

const workflowOutcomeSchema = z.object({
  outcome: z.string().min(1),
  reason: z.string().min(1)
})

const workflowTransitionSchema = z
  .object({
    condition: workflowConditionSchema,
    nextStep: z.string().min(1).optional(),
    outcome: z.string().min(1).optional(),
    reason: z.string().optional(),
    stateUpdates: z.record(z.string(), z.string()).optional()
  })
  .refine((value) => Boolean(value.outcome || value.nextStep), {
    message: 'Transition must specify either an outcome or a nextStep.'
  })
  .refine((value) => !(value.outcome && !value.reason), {
    message: 'Outcome transitions must specify a reason.'
  })

const workflowStepSchema = z.object({
  key: z.string().min(1),
  role: z.string().min(1),
  prompt: z.array(z.string()).min(1),
  next: z.string().min(1).optional(),
  stateUpdates: z.record(z.string(), z.string()).optional(),
  transitions: z.array(workflowTransitionSchema).optional(),
  exits: z.array(workflowTransitionSchema).optional()
})

const workflowRoundSchema = z
  .object({
    start: z.string().min(1).optional(),
    steps: z.array(workflowStepSchema).min(1),
    maxRounds: z.number().int().positive().optional(),
    defaultOutcome: workflowOutcomeSchema
  })
  .superRefine((round, ctx) => {
    const seen = new Set<string>()
    round.steps.forEach((step, index) => {
      if (seen.has(step.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate step key: ${step.key}`,
          path: ['steps', index, 'key']
        })
      }
      seen.add(step.key)
    })

    if (round.start && !seen.has(round.start)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Round start step ${round.start} is not defined in steps.`,
        path: ['start']
      })
    }

    round.steps.forEach((step, index) => {
      if (step.next && !seen.has(step.next)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Step ${step.key} references unknown next step ${step.next}.`,
          path: ['steps', index, 'next']
        })
      }

      const validateTransitions = (
        transitions: z.infer<typeof workflowTransitionSchema>[] | undefined,
        property: string
      ) => {
        transitions?.forEach((transition, tIndex) => {
          if (transition.nextStep && !seen.has(transition.nextStep)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Step ${step.key} ${property}[${tIndex}] references unknown next step ${transition.nextStep}.`,
              path: ['steps', index, property, tIndex, 'nextStep']
            })
          }
        })
      }

      validateTransitions(step.transitions, 'transitions')
      validateTransitions(step.exits, 'exits')
    })
  })

const workflowSessionRoleSchema = z.object({
  role: z.string().min(1),
  nameTemplate: z.string().optional()
})

const workflowRoleDefinitionSchema = z.object({
  systemPrompt: z.string().min(1),
  parser: z.string()
})

const workflowRolesSchema = z
  .record(z.string(), workflowRoleDefinitionSchema)
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one role must be defined.'
  })

export const workflowDefinitionSchema = z.object({
  $schema: z.string().optional(),
  id: z.string().min(1),
  description: z.string().optional(),
  model: z.string().optional(),
  sessions: z.object({
    roles: z.array(workflowSessionRoleSchema).min(1)
  }),
  roles: workflowRolesSchema,
  state: z
    .object({
      initial: z.record(z.string(), z.string()).optional()
    })
    .optional(),
  flow: z.object({
    bootstrap: workflowStepSchema.optional(),
    round: workflowRoundSchema
  })
})

type WorkflowConditionDraft = z.infer<typeof workflowConditionSchema>
type WorkflowOutcomeTemplateDraft = z.infer<typeof workflowOutcomeSchema>
type WorkflowTransitionDraft = z.infer<typeof workflowTransitionSchema>
type WorkflowStepDraft = z.infer<typeof workflowStepSchema>
type WorkflowDefinitionDraft = z.infer<typeof workflowDefinitionSchema>

export type WorkflowCondition = DeepReadonly<WorkflowConditionDraft>
export type WorkflowOutcomeTemplate = DeepReadonly<WorkflowOutcomeTemplateDraft>
export type WorkflowTransitionDefinition = DeepReadonly<WorkflowTransitionDraft>
export type WorkflowStepDefinition = DeepReadonly<WorkflowStepDraft>
export type AgentWorkflowDefinition = DeepReadonly<WorkflowDefinitionDraft>
export type WorkflowRoleDefinition = DeepReadonly<z.infer<typeof workflowRoleDefinitionSchema>>
export type WorkflowRoleParser = WorkflowRoleDefinition['parser']
export type WorkflowFieldCondition = DeepReadonly<z.infer<typeof atomicConditionSchema>>
export type AgentWorkflowDefinitionDraft = WorkflowDefinitionDraft
