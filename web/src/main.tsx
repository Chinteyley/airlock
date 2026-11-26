import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installWire } from './lib/wire'
import App from './App'
import './index.css'

installWire()

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
