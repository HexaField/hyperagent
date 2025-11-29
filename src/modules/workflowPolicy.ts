import type { ProjectRecord } from './projects'
import type { WorkflowRecord, WorkflowStepRecord } from './workflows'

export type WorkflowPolicyDecision = {
  allowed: boolean
  reason?: string
  metadata?: Record<string, unknown>
}

export type WorkflowPolicyEvaluation = {
  workflow: WorkflowRecord
  project: ProjectRecord
  step: WorkflowStepRecord
  branchInfo: { name: string; baseBranch: string }
}

export type WorkflowPolicy = {
  authorizeStep: (input: WorkflowPolicyEvaluation) => Promise<WorkflowPolicyDecision>
}

export const allowAllWorkflowPolicy: WorkflowPolicy = {
  authorizeStep: async () => ({ allowed: true })
}

type EnvConfig = {
  protectedBranches?: string
  approvalToken?: string
}

const toList = (value?: string): string[] => {
  if (!value) return []
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length)
}

const extractPolicyToken = (workflow: WorkflowRecord): string | null => {
  const data = workflow.data ?? {}
  const policy = typeof data === 'object' && data ? (data as Record<string, unknown>).policy : undefined
  if (policy && typeof policy === 'object' && policy !== null && !Array.isArray(policy)) {
    const token = (policy as Record<string, unknown>).approvalToken
    if (typeof token === 'string' && token.trim().length) {
      return token.trim()
    }
  }
  return null
}

export const createWorkflowPolicyFromEnv = (env: NodeJS.ProcessEnv, config: EnvConfig = {}): WorkflowPolicy => {
  const protectedBranches = toList(config.protectedBranches ?? env.WORKFLOW_PROTECTED_BRANCHES)
  const requiredToken = (config.approvalToken ?? env.WORKFLOW_POLICY_APPROVAL_TOKEN)?.trim() ?? null

  if (!protectedBranches.length && !requiredToken) {
    return allowAllWorkflowPolicy
  }

  return {
    authorizeStep: async ({ branchInfo, workflow }) => {
      const normalizedBranch = branchInfo.name.toLowerCase()
      const normalizedBase = branchInfo.baseBranch.toLowerCase()
      const branchIsProtected = protectedBranches.some((entry) => entry === normalizedBranch || entry === normalizedBase)
      if (!branchIsProtected) {
        return {
          allowed: true,
          metadata: {
            protected: false
          }
        }
      }
      const approvalToken = extractPolicyToken(workflow)
      if (!approvalToken) {
        return {
          allowed: false,
          reason: 'Workflow policy requires an approval token for protected branches.',
          metadata: {
            protected: true,
            branch: branchInfo.name,
            baseBranch: branchInfo.baseBranch
          }
        }
      }
      if (requiredToken && approvalToken !== requiredToken) {
        return {
          allowed: false,
          reason: 'Supplied approval token is invalid for the configured workflow policy.',
          metadata: {
            protected: true,
            branch: branchInfo.name,
            baseBranch: branchInfo.baseBranch
          }
        }
      }
      return {
        allowed: true,
        metadata: {
          protected: true,
          branch: branchInfo.name,
          baseBranch: branchInfo.baseBranch,
          approvalTokenVerified: Boolean(requiredToken)
        }
      }
    }
  }
}
