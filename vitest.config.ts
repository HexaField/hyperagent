import solidPlugin from 'vite-plugin-solid'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    watch: false,
    passWithNoTests: true,
    exclude: ['node_modules/**', 'dist/**', 'external/**', '**/.{tmp,temp}/**', '**/.tmp/**', '**/.tests/**'],
    environment: 'node',
    environmentMatchGlobs: [['web/**', 'jsdom']],
    setupFiles: ['./vitest.setup.ts']
  },
  server: {
    deps: {
      external: ['ws']
    }
  },
  ssr: {
    external: ['ws']
  }
})
