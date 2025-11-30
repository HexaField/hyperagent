import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    bail: 1,
    reporters: 'default'
  }
})
