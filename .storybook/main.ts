import path from 'path'
import type { StorybookConfig } from '@storybook/html-vite'
import solid from 'vite-plugin-solid'

const config: StorybookConfig = {
  stories: ['../web/src/**/*.stories.@(js|jsx|ts|tsx)'],
  addons: ['@storybook/addon-essentials', '@storybook/addon-interactions'],
  framework: {
    name: '@storybook/html-vite',
    options: {}
  },
  docs: {
    autodocs: 'tag'
  },
  viteFinal: async (config) => {
    const plugins = config.plugins ?? []
    plugins.push(solid())

    config.plugins = plugins
    config.resolve = config.resolve ?? {}
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      '@web': path.resolve(__dirname, '../web/src')
    }

    return config
  }
}

export default config
