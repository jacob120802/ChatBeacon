import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/twitch': 'http://127.0.0.1:3001',
      '/community-pulse': 'http://127.0.0.1:3001',
      '/overlay': 'http://127.0.0.1:3001',
    },
  },
})
