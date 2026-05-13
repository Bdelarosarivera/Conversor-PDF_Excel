import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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

