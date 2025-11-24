import { render } from 'solid-js/web'
import App from './App'
import './index.css'
import { getStoredTheme, applyTheme } from './lib/theme'

const cleanup = applyTheme(getStoredTheme() ?? 'system')

// Ensure cleanup when the page is unloaded
if (cleanup && typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    try {
      cleanup()
    } catch (e) {
      /* ignore */
    }
  })
}

render(() => <App />, document.getElementById('root')!)
