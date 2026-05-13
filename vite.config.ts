import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig(({ mode }) => {
  // Carga las variables de entorno
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      react(),
      tailwindcss(),
    ],

    // IMPORTANTE:
    // Usa '/' si trabajas localmente o en Render/Vercel
    // Usa '/Conversor-PDF_Excel/' SOLO si publicas en GitHub Pages
    base: '/',

    define: {
      'process.env': {
        GEMINI_API_KEY: env.GEMINI_API_KEY || '',
      },
    },

    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },

    server: {
      host: '0.0.0.0',
      port: 5173,
      open: true,
    },

    preview: {
      host: '0.0.0.0',
      port: 4173,
    },

    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 1000,
    },

    optimizeDeps: {
      include: ['react', 'react-dom'],
    },
  };
});
