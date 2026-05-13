import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// IMPORTANTE:
// Cambia este nombre EXACTAMENTE por el nombre de tu repositorio en GitHub
const REPO_NAME = 'Conversor-PDF_Excel';

export default defineConfig({
  plugins: [react(), tailwindcss()],

  // SOLUCIÓN PARA GITHUB PAGES
  base: `/${REPO_NAME}/`,

  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },

  define: {
    global: 'globalThis',
  },

  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },

  server: {
    host: '0.0.0.0',
    port: 3000,
  },
});
