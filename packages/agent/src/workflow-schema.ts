import { z } from 'zod'

type DeepReadonly<T> = T extends (...args: any[]) => any
  ? T
  : T extends Date
    ? T
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T

type WorkflowParserJsonSchemaDraft =
  | {
      type: 'unknown'
      default?: unknown
    }
  | {
      type: 'string'
      enum?: ReadonlyArray<string>
      default?: string
      minLength?: number
      maxLength?: number
    }
  | {
      type: 'number'
      enum?: ReadonlyArray<number>
      minimum?: number
      maximum?: number
      integer?: boolean
      default?: number
    }
  | {
      type: 'boolean'
      default?: boolean
    }
  | {
      type: 'array'
      items: WorkflowParserJsonSchemaDraft
      default?: ReadonlyArray<unknown>
    }
  | {
      type: 'object'
      properties: Record<string, WorkflowParserJsonSchemaDraft>
      required?: ReadonlyArray<string>
      additionalProperties?: boolean
      default?: Record<string, unknown>
    }

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

const workflowParserJsonSchema: z.ZodType<WorkflowParserJsonSchemaDraft> = z.lazy(
  () =>
    z.union([
      z.object({
        type: z.literal('unknown'),
        default: z.any().optional()
      }),
      z.object({
        type: z.literal('string'),
        enum: z.array(z.string()).min(1).optional(),
        default: z.string().optional(),
        minLength: z.number().int().min(0).optional(),
        maxLength: z.number().int().min(0).optional()
      }),
      z.object({
        type: z.literal('number'),
        enum: z.array(z.number()).min(1).optional(),
        minimum: z.number().optional(),
        maximum: z.number().optional(),
        integer: z.boolean().optional(),
        default: z.number().optional()
      }),
      z.object({
        type: z.literal('boolean'),
        default: z.boolean().optional()
      }),
      z.object({
        type: z.literal('array'),
        items: workflowParserJsonSchema,
        default: z.array(z.any()).optional()
      }),
      z.object({
        type: z.literal('object'),
        properties: z.record(z.string(), workflowParserJsonSchema),
        required: z.array(z.string()).optional(),
        additionalProperties: z.boolean().optional(),
        default: z.any().optional()
      })
    ]) as z.ZodType<WorkflowParserJsonSchemaDraft>
)

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
  parsers: z.record(z.string(), workflowParserJsonSchema).optional(),
  roles: workflowRolesSchema,
  state: z
    .object({
      initial: z.record(z.string(), z.string()).optional()
    })
    .optional(),
  flow: z.object({
    bootstrap: workflowStepSchema.optional(),
    round: workflowRoundSchema
  }),
  // Optional user input schema. Each key maps to a compact JSON-schema-like
  // parser (the same shape used for `parsers`) describing the expected type
  // and optional default value for that input. Runtime callers can provide a
  // `user` object matching these keys; values will be typed/validated
  // according to the provided schema.
  user: z.record(z.string(), workflowParserJsonSchema).optional()
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
export type WorkflowParserJsonSchema = DeepReadonly<WorkflowParserJsonSchemaDraft>

const ensureEnum = <T extends string>(values: ReadonlyArray<T>): [T, ...T[]] => {
  if (values.length === 0) {
    throw new Error('Enum definitions must include at least one value')
  }
  const [first, ...rest] = values
  return [first, ...rest]
}

export type JsonSchemaType<T extends WorkflowParserJsonSchema> = T extends { type: 'string' }
  ? string
  : T extends { type: 'number' }
    ? number
    : T extends { type: 'boolean' }
      ? boolean
      : T extends { type: 'array'; items: infer Item extends WorkflowParserJsonSchema }
        ? Array<JsonSchemaType<Item>>
        : T extends { type: 'object'; properties: infer P extends Record<string, WorkflowParserJsonSchema> }
          ? ObjectFromProperties<P, T extends { required: readonly string[] } ? T['required'] : undefined>
          : unknown

export type WorkflowParserJsonOutput<TSchema extends WorkflowParserJsonSchema> = JsonSchemaType<TSchema>

type RequiredKeyUnion<Keys> = Keys extends ReadonlyArray<infer K> ? K & string : never

type ObjectFromProperties<
  Props extends Record<string, WorkflowParserJsonSchema>,
  RequiredKeys extends ReadonlyArray<string> | undefined
> = {
  [K in keyof Props as K extends RequiredKeyUnion<RequiredKeys> ? K : never]: JsonSchemaType<Props[K]>
} & {
  [K in keyof Props as K extends RequiredKeyUnion<RequiredKeys> ? never : K]?: JsonSchemaType<Props[K]>
}

export function workflowParserSchemaToZod<const TSchema extends WorkflowParserJsonSchema>(
  schemaInput: TSchema
): z.ZodType<JsonSchemaType<TSchema>> {
  const castParser = (parser: z.ZodTypeAny): z.ZodType<JsonSchemaType<TSchema>> =>
    parser as unknown as z.ZodType<JsonSchemaType<TSchema>>

  const schema = schemaInput as WorkflowParserJsonSchemaDraft

  switch (schema.type) {
    case 'unknown': {
      const base = z.unknown()
      return castParser(schema.default !== undefined ? base.default(schema.default) : base)
    }
    case 'string': {
      if (schema.enum) {
        const parser = z.enum(ensureEnum(schema.enum))
        return castParser(schema.default !== undefined ? parser.default(schema.default) : parser)
      }
      let parser = z.string()
      if (schema.minLength !== undefined) parser = parser.min(schema.minLength)
      if (schema.maxLength !== undefined) parser = parser.max(schema.maxLength)
      return castParser(schema.default !== undefined ? parser.default(schema.default) : parser)
    }
    case 'number': {
      if (schema.enum && schema.enum.length > 0) {
        const parser = z.union(
          schema.enum.map((value: number) => z.literal(value)) as [z.ZodLiteral<number>, ...z.ZodLiteral<number>[]]
        )
        return castParser(schema.default !== undefined ? parser.default(schema.default) : parser)
      }
      let parser = z.number()
      if (schema.integer) parser = parser.int()
      if (schema.minimum !== undefined) parser = parser.min(schema.minimum)
      if (schema.maximum !== undefined) parser = parser.max(schema.maximum)
      return castParser(schema.default !== undefined ? parser.default(schema.default) : parser)
    }
    case 'boolean': {
      const parser = z.boolean()
      return castParser(schema.default !== undefined ? parser.default(schema.default) : parser)
    }
    case 'array': {
      const items = workflowParserSchemaToZod(schema.items)
      let parser: z.ZodTypeAny = z.array(items)
      if (schema.default !== undefined) {
        parser = parser.default([...schema.default])
      }
      return castParser(parser)
    }
    case 'object': {
      const required = new Set(schema.required ?? [])
      const shape: Record<string, z.ZodTypeAny> = {}
      for (const [key, value] of Object.entries(schema.properties)) {
        let propertySchema = workflowParserSchemaToZod(value as WorkflowParserJsonSchema)
        const hasDefault = 'default' in value && (value as { default?: unknown }).default !== undefined
        if (!required.has(key) && !hasDefault) {
          propertySchema = propertySchema.optional()
        }
        shape[key] = propertySchema
      }
      let parser: z.ZodTypeAny = z.object(shape)
      if (schema.additionalProperties === false) {
        parser = (parser as z.ZodObject<any>).strict()
      }
      if (schema.default !== undefined) {
        parser = parser.default({ ...schema.default })
      }
      return castParser(parser)
    }
    default: {
      const exhaustive: never = schema
      return exhaustive
    }
  }
}
