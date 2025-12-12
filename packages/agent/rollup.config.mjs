import path from 'path'
import fg from 'fast-glob'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import typescript from '@rollup/plugin-typescript'
import fs from 'fs'

const base = path.resolve(process.cwd())

const entries = [
  'src/index.ts',
  'src/agent.ts',
  'src/agent-orchestrator.ts',
  'src/opencode.ts',
  'src/provenance.ts',
  'src/workflow-schema.ts',
  'src/workflows/index.ts',
  ...fg.sync('src/workflows/*.workflow.ts')
]

export default {
  input: entries,
  external: ['@opencode-ai/sdk', 'zod'],
  plugins: [
    nodeResolve({ preferBuiltins: true }),
    commonjs(),
    typescript({ tsconfig: path.join(base, 'tsconfig.json'), sourceMap: true }),
    // Post-build tasks: copy workflow README files into dist
    {
      name: 'post-build-copy-readme',
      async writeBundle() {
        try {
          const pkgDir = base
          const distWorkflows = path.join(pkgDir, 'dist', 'workflows')
          await fs.promises.mkdir(distWorkflows, { recursive: true })
          const srcReadme = path.join(pkgDir, 'src', 'workflows', 'README.md')
          const distReadme = path.join(pkgDir, 'dist', 'README.md')
          const distWorkflowsReadme = path.join(distWorkflows, 'README.md')
          if (fs.existsSync(srcReadme)) {
            await fs.promises.copyFile(srcReadme, distReadme)
            await fs.promises.copyFile(srcReadme, distWorkflowsReadme)
          }
        } catch (err) {
          this.error(err)
        }
      }
    }
  ],
  output: {
    dir: 'dist',
    format: 'esm',
    sourcemap: true,
    preserveModules: true,
    entryFileNames: '[name].js',
    preserveModulesRoot: 'src'
  }
}
