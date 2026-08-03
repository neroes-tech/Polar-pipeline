import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './i18n/index.js'
import './styles/global.css'
import App from './App.jsx'
import { purgeServiceWorkerOnNative } from './lib/purgeServiceWorker.js'

function render() {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

// Purge before the first render so a leftover service worker from an older
// build can't intercept the very first Supabase requests App.jsx makes. All
// local work (no network), so it's fast — but bounded, and it renders anyway
// on failure: nothing here is worth blocking startup over. Not top-level
// await, which the build target doesn't support.
Promise.race([
  purgeServiceWorkerOnNative(),
  new Promise(resolve => setTimeout(resolve, 3000)),
])
  .catch(() => {})
  .then(render)
