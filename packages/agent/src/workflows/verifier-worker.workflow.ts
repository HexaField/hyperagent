import type { AgentWorkflowDefinition } from '../workflow-schema'

export const verifierWorkerWorkflowDocument = {
  $schema: 'https://hyperagent.dev/schemas/agent-workflow.json',
  id: 'verifier-worker.v1',
  description: 'Two-role workflow pairing a worker and verifier with iterative feedback.',
  model: 'github-copilot/gpt-5-mini',
  sessions: {
    roles: [
      { role: 'worker' as const, nameTemplate: '{{runId}}-worker' },
      { role: 'verifier' as const, nameTemplate: '{{runId}}-verifier' }
    ]
  },
  parsers: {
    worker: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['working', 'done', 'blocked'] },
        plan: { type: 'string' },
        work: { type: 'string' },
        requests: { type: 'string', default: '' }
      },
      required: ['status', 'plan', 'work']
    },
    verifier: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['instruct', 'approve', 'fail'] },
        critique: { type: 'string' },
        instructions: { type: 'string' },
        priority: { type: 'number', integer: true, minimum: 1, maximum: 5 }
      },
      required: ['verdict', 'critique', 'instructions', 'priority']
    }
  },
  roles: {
    worker: {
      systemPrompt:
        'You are a meticulous senior engineer agent focused on producing concrete, technically sound deliverables. Follow verifier instructions with discipline.\n\nAlways return STRICT JSON with the shape:\n{\n  "status": "working" | "done" | "blocked",\n  "plan": "short bullet-style plan clarifying approach",\n  "work": "precise description of what you produced or analysed",\n  "requests": "questions or additional info you need (empty string if none)"\n}\n\nRules:\n- Think aloud inside the plan field; keep "work" actionable (code, commands, or decisions).\n- Use status "done" only when you believe the user instructions are satisfied.\n- Use status "blocked" when you cannot proceed without missing info; include what is missing in requests.\n- Never include Markdown fences or commentary outside the JSON object.',
      parser: 'worker'
    },
    verifier: {
      systemPrompt:
        'You are a staff-level instructor verifying a worker agent\'s output for a demanding software task.\n\nResponsibilities:\n1. Internalize the user\'s objectives and acceptance criteria.\n2. Examine the worker\'s most recent JSON response for correctness, completeness, safety, and alignment with the user request.\n3. Provide laser-focused guidance that unblocks or sharpens the worker\'s next move.\n\nResponse policy:\n- Always return STRICT JSON with the shape:\n{\n  "verdict": "instruct" | "approve" | "fail",\n  "critique": "succinct reasoning referencing concrete requirements",\n  "instructions": "ordered guidance for the worker to follow next",\n  "priority": number (1-5, where 1 is critical blocker)\n}\n- Use verdict "approve" ONLY when the worker\'s latest submission fully satisfies the user instructions.\n- Use "fail" when the worker is off-track or violating constraints; clearly state blockers in critique.\n- Otherwise respond with "instruct" and provide the next best set of actions in the instructions field.\n- Keep critiques grounded in evidence and reference specific user needs or defects.\n- Assume future turns depend solely on your guidance—be explicit about quality bars, edge cases, and verification steps.',
      parser: 'verifier'
    }
  },
  state: {
    initial: {
      pendingInstructions: '{{user.instructions}}',
      latestCritique: ''
    }
  },
  user: {
    instructions: { type: 'string', default: '' }
  },
  flow: {
    bootstrap: {
      key: 'bootstrap',
      role: 'verifier' as const,
      prompt: [
        'User instructions:\n{{user.instructions}}',
        'The worker has not produced any output yet. Provide the first set of instructions that sets them up for success.'
      ],
      stateUpdates: {
        pendingInstructions: '{{parsed.instructions||user.instructions}}',
        latestCritique: '{{parsed.critique||state.latestCritique}}'
      }
    },
    round: {
      start: 'worker',
      steps: [
        {
          key: 'worker',
          role: 'worker' as const,
          next: 'verifier',
          prompt: [
            'Primary task from the user:\n{{user.instructions}}',
            'Verifier guidance for round #{{round}}:\n{{state.pendingInstructions}}',
            '{{state.latestCritique}}',
            'Deliver concrete progress that can be validated immediately.'
          ],
          transitions: [
            {
              condition: { field: 'parsed.status', equals: 'blocked' },
              outcome: 'failed',
              reason: '{{parsed.requests||"worker reported blocked status"}}'
            }
          ]
        },
        {
          key: 'verifier',
          role: 'verifier' as const,
          prompt: [
            'User instructions:\n{{user.instructions}}',
            'Latest worker JSON (round #{{round}}):\n{{steps.worker.raw}}',
            'Evaluate the worker output, note gaps, and craft the next set of instructions.'
          ],
          stateUpdates: {
            pendingInstructions: '{{parsed.instructions||state.pendingInstructions}}',
            latestCritique: '{{parsed.critique||state.latestCritique}}'
          },
          exits: [
            {
              condition: { field: 'parsed.verdict', equals: 'approve' },
              outcome: 'approved',
              reason: '{{parsed.critique||"Verifier approved the work"}}'
            },
            {
              condition: { field: 'parsed.verdict', equals: 'fail' },
              outcome: 'failed',
              reason: '{{parsed.critique||"Verifier rejected the work"}}'
            }
          ]
        }
      ],
      maxRounds: 10,
      defaultOutcome: {
        outcome: 'max-rounds',
        reason: 'Verifier never approved within {{maxRounds}} rounds'
      }
    }
  }
} as const satisfies AgentWorkflowDefinition
