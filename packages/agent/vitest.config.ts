import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    fileParallelism: false,
    watch: false,
    passWithNoTests: true,
    exclude: ['node_modules/**', 'serve/node_modules/**', 'dist/**'],
    environment: 'node',
    environmentMatchGlobs: [],
    setupFiles: []
  }
})
