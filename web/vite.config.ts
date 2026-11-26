import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The fixtures live at the repo root so the iOS app reads the same file.
export default defineConfig({
  plugins: [react()],
  server: { port: 5180, strictPort: true, fs: { allow: ['..'] } },
})
