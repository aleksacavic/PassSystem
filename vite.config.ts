import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { securityHeaders } from './security-headers.mjs'

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env }
  const supabaseOrigin = env.VITE_SUPABASE_URL ? new URL(env.VITE_SUPABASE_URL).origin : undefined
  return {
    plugins: [react(), tailwindcss()],
    server: { port: 5173, strictPort: true },
    // Preview serves the production build with the production security headers.
    preview: { port: 4173, strictPort: true, headers: securityHeaders(supabaseOrigin) },
    build: { sourcemap: false, target: 'es2020' },
  }
})
