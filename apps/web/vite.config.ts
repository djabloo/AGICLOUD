import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // ws:true: altrimenti il proxy di sviluppo non inoltra l'upgrade WebSocket del terminale
    // (/api/terminals/:id/ws) e la connessione resta sospesa senza errori.
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.PORT || 3095}`, ws: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
