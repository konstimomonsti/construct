import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'tender-desk-route',
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          const url = request.url ?? ''
          const path = url.split('?', 1)[0]
          if (path === '/tender-desk' || path === '/tender-desk/') {
            request.url = '/tender-desk/index.html' + url.slice(path.length)
          }
          next()
        })
      },
    },
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/admin': 'http://127.0.0.1:8080',
      '/healthz': 'http://127.0.0.1:8080',
    },
  },
})
