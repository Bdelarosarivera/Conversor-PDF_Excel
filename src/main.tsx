import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

import * as pdfjs from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Configuración correcta del worker PDF
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('No se encontró el elemento root');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
