import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { linkImport } from './server/linkProxy';

/**
 * The AI backend (FastAPI, backend/) listens on 127.0.0.1 only; browsers — including other devices on
 * the LAN — reach it through this same-origin proxy, so it never needs its own open port or CORS.
 */
const aiBackend = { '/api/ai': { target: process.env.FOLIO_AI_URL ?? 'http://127.0.0.1:8765', changeOrigin: false } };

export default defineConfig({
  plugins: [react(), tailwindcss(), linkImport()],
  // pdf.js ships modern ESM (top-level await, private fields).
  build: { target: 'es2022', chunkSizeWarningLimit: 1600 },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  server: { port: 5173, proxy: aiBackend },
  preview: { proxy: aiBackend },
});
