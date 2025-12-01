'use strict'

const wsModule = require('ws')
const WebSocketServer = wsModule.WebSocketServer || wsModule.Server

const responseText = process.env.SIDECAR_RESPONSE_TEXT || 'Affirmative.'
const tokenDelay = Number(process.env.SIDECAR_TOKEN_DELAY_MS || 10)
const pathName = process.env.SIDECAR_PATH || '/ws/chat'

const server = new WebSocketServer({ port: 0, path: pathName })

const conversationFromPayload = (payload) => {
  if (payload && typeof payload === 'object') {
    return payload.conversation_id || payload.conversationId || null
  }
  return null
}

server.on('listening', () => {
  const address = server.address()
  process.send?.({ type: 'ready', port: address.port })
})

server.on('connection', (socket) => {
  process.send?.({ type: 'connection' })
  socket.on('message', (raw) => {
    let payload
    try {
      payload = JSON.parse(raw.toString())
    } catch (error) {
      payload = null
    }
    const conversationId = conversationFromPayload(payload)
    process.send?.({ type: 'message', payload })
    const parts = responseText.split(' ')
    parts.forEach((part, index) => {
      const token = index < parts.length - 1 ? `${part} ` : part
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            type: 'token',
            token,
            conversation_id: conversationId
          })
        )
      }, index * tokenDelay)
    })
    setTimeout(() => {
      socket.send(
        JSON.stringify({
          type: 'done',
          conversation_id: conversationId
        })
      )
    }, parts.length * tokenDelay + tokenDelay)
  })
})

server.on('error', (error) => {
  process.send?.({ type: 'error', message: error.message })
})

const shutdown = () => {
  server.close(() => {
    process.exit(0)
  })
}

process.on('message', (message) => {
  if (message && typeof message === 'object' && message.type === 'shutdown') {
    shutdown()
  }
})

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
