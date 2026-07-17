import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
const apiProxy = {
  '/projects': 'http://localhost:8000',
  '/sections': 'http://localhost:8000',
  '/pick-folder': 'http://localhost:8000',
  '/running-projects': 'http://localhost:8000',
  '/open-vscode': 'http://localhost:8000',
}

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: apiProxy,
  },
  // `vite preview` (modo buildado) não herda o proxy do server de dev —
  // precisa da própria config, senão as chamadas de API dão 404.
  preview: {
    proxy: apiProxy,
  },
})
