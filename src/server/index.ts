import { createServerApp } from './app'
import { createLogger, toErrorMeta } from './core/logging'

const cliLogger = createLogger('ui/server/index', { service: 'ui-server' })

async function startServer() {
  const serverInstance = await createServerApp()
  serverInstance.start()

  const shutdown = async () => {
    await serverInstance.shutdown()
  }

  process.on('exit', () => {
    void shutdown()
  })

  process.on('SIGINT', async () => {
    await shutdown()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    await shutdown()
    process.exit(0)
  })
}

startServer().catch((error) => {
  cliLogger.error('Failed to start UI server', { error: toErrorMeta(error) })
  process.exit(1)
})
