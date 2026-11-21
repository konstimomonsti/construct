import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Keep the browser's Host header so the backend's same-origin check accepts writes (POST) from the dev server.
const backend = { target: 'http://127.0.0.1:8080', changeOrigin: false }

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/admin': backend,
      '/healthz': backend,
    },
  },
})
