import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// IPv4 explícito: "localhost" resolve pra ::1 primeiro em algumas máquinas, e
// se houver outro serviço publicado no mesmo IPv6 curinga, o proxy acaba
// caindo nele em vez do backend. Porta 8010 (não 8000) porque 8000 é do
// container Docker do ressona-backend em outro projeto — colidia com este
// backend quando os dois usavam a mesma porta.
const apiProxy = {
  '/projects': 'http://127.0.0.1:8010',
  '/sections': 'http://127.0.0.1:8010',
  '/activities': 'http://127.0.0.1:8010',
  '/running-activities': 'http://127.0.0.1:8010',
  '/attachments': 'http://127.0.0.1:8010',
  '/pick-folder': 'http://127.0.0.1:8010',
  '/git-branches': 'http://127.0.0.1:8010',
  '/running-projects': 'http://127.0.0.1:8010',
  '/open-vscode': 'http://127.0.0.1:8010',
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
