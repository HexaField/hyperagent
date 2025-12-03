import baseConfig from './vitest.config'
import { defineConfig, mergeConfig } from 'vitest/config'
import { workerTestFiles } from './vitest.worker-tests'

const baseExcludes = Array.isArray(baseConfig.test?.exclude) ? baseConfig.test?.exclude : []

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      exclude: [...baseExcludes, ...workerTestFiles]
    }
  })
)
