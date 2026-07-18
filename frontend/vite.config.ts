import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// IPv4 explícito: "localhost" resolve pra ::1 primeiro em algumas máquinas, e
// se houver outro serviço (ex: container Docker) publicado em [::]:8000, o
// proxy acaba caindo nele em vez do backend.
const apiProxy = {
  '/projects': 'http://127.0.0.1:8000',
  '/sections': 'http://127.0.0.1:8000',
  '/activities': 'http://127.0.0.1:8000',
  '/running-activities': 'http://127.0.0.1:8000',
  '/pick-folder': 'http://127.0.0.1:8000',
  '/git-branches': 'http://127.0.0.1:8000',
  '/running-projects': 'http://127.0.0.1:8000',
  '/open-vscode': 'http://127.0.0.1:8000',
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
