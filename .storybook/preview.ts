import type { Preview } from '@storybook/html'
import '../web/src/index.css'

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/
      }
    },
    backgrounds: {
      default: 'app',
      values: [
        { name: 'app', value: 'var(--bg-app)' },
        { name: 'card', value: 'var(--bg-card)' },
        { name: 'contrast', value: '#0f172a' }
      ]
    }
  }
}

export default preview
