import type { WorkflowRuntime } from '../../../src/modules/workflows'
import type { ReviewScheduler } from '../../../src/modules/review/scheduler'
import type { WorkspaceTerminalModule } from '../modules/workspaceTerminal/module'

export type ManagedService = {
  name: string
  start: () => Promise<void> | void
  stop: () => Promise<void> | void
}

export const startManagedServices = async (services: ManagedService[]): Promise<void> => {
  for (const service of services) {
    await service.start()
  }
}

export const stopManagedServices = async (services: ManagedService[]): Promise<void> => {
  for (const service of [...services].reverse()) {
    await service.stop()
  }
}

export const createWorkflowRuntimeService = (options: {
  runtime: WorkflowRuntime
  manageLifecycle: boolean
}): ManagedService => {
  const { runtime, manageLifecycle } = options
  return {
    name: 'workflowRuntime',
    start: async () => {
      if (!manageLifecycle) return
      runtime.startWorker()
    },
    stop: async () => {
      if (!manageLifecycle) return
      await runtime.stopWorker()
    }
  }
}

export const createReviewSchedulerService = (scheduler: ReviewScheduler): ManagedService => {
  return {
    name: 'reviewScheduler',
    start: async () => {
      scheduler.startWorker()
    },
    stop: async () => {
      await scheduler.stopWorker()
    }
  }
}

export const createCodeServerService = (deps: {
  shutdownAllCodeServers: () => Promise<void>
}): ManagedService => {
  return {
    name: 'codeServerSessions',
    start: async () => {
      // code-server controllers are created on demand
    },
    stop: async () => {
      await deps.shutdownAllCodeServers()
    }
  }
}

export const createTerminalService = (module: WorkspaceTerminalModule): ManagedService => {
  return {
    name: 'workspaceTerminal',
    start: async () => {
      // terminal websocket server is ready after construction
    },
    stop: async () => {
      await module.shutdown()
    }
  }
}
