import solidPlugin from 'vite-plugin-solid'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    watch: false,
    passWithNoTests: true,
    exclude: ['node_modules/**', 'dist/**', 'external/**', '**/.{tmp,temp}/**', '**/.tmp/**', '**/.tests/**'],
    environment: 'node',
    environmentMatchGlobs: [
      ['web/**', 'jsdom'],
      ['src/client/**', 'jsdom']
    ],
    setupFiles: ['./vitest.setup.ts']
  },
  optimizeDeps: {
    exclude: ['ws']
  },
  ssr: {
    external: ['ws']
  }
})
