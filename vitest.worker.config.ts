import baseConfig from './vitest.config'
import { defineConfig, mergeConfig } from 'vitest/config'
import { workerTestFiles } from './vitest.worker-tests'

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: [...workerTestFiles]
    }
  })
)
