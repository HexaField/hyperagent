import path from 'path'
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/agent.ts',
    'src/agent-orchestrator.ts',
    'src/opencode.ts',
    'src/opencodeTestHooks.ts',
    'src/provenance.ts',
    'src/workflow-schema.ts',
    'src/workflows/index.ts',
    'src/workflows/*.workflow.ts'
  ],
  tsconfig: path.resolve(__dirname, 'tsconfig.json'),
  format: ['esm'],
  target: 'node18',
  sourcemap: true,
  dts: false,
  splitting: false,
  clean: true,
  outDir: 'dist',
  external: ['@opencode-ai/sdk', 'zod']
})
