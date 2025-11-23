import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    watch: false,
    passWithNoTests: true,
    exclude: ['node_modules/**', 'dist/**', 'external/**', '**/.{tmp,temp}/**', '**/.tmp/**']
  }
})
