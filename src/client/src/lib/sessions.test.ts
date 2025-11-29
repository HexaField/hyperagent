import { describe, expect, it } from 'vitest'
import { buildSessionWorkflowPayload } from './sessions'

describe('buildSessionWorkflowPayload', () => {
  it('builds a session workflow payload with trimmed values', () => {
    const payload = buildSessionWorkflowPayload({
      projectId: 'project-1',
      sessionName: '  Hotfix session  ',
      sessionDetails: '  Investigate flaky tests  '
    })

    expect(payload.projectId).toBe('project-1')
    expect(payload.kind).toBe('session')
    expect(payload.autoStart).toBe(true)
    expect(payload.data).toEqual({
      sessionName: 'Hotfix session',
      sessionDetails: 'Investigate flaky tests',
      source: 'repositories:new-session'
    })
    expect(payload.tasks).toHaveLength(1)
    expect(payload.tasks[0]).toEqual({
      title: 'Hotfix session',
      instructions: 'Investigate flaky tests',
      agentType: 'coding'
    })
  })

  it('throws when required fields are missing', () => {
    expect(() =>
      buildSessionWorkflowPayload({ projectId: 'project-1', sessionName: ' ', sessionDetails: 'anything' })
    ).toThrow(/session name/i)
    expect(() =>
      buildSessionWorkflowPayload({ projectId: 'project-1', sessionName: 'valid', sessionDetails: '    ' })
    ).toThrow(/session details/i)
  })
})
