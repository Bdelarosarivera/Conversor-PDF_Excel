import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],

  // IMPORTANTE
  base: '/Conversor-PDF_Excel/',

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
  },
});
