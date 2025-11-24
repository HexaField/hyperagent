import { createServerApp } from './app'

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
  console.error('Failed to start UI server', error)
  process.exit(1)
})
