import { useState, useRef } from 'react';
import {
  FileText, Download, RefreshCw, CheckCircle,
  AlertCircle, Calculator, ClipboardList,
  FileSpreadsheet, TrendingDown, TrendingUp, DollarSign
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as pdfjs from 'pdfjs-dist';
import * as XLSX from 'xlsx';
import { createWorker } from 'tesseract.js';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;

/* ============================
   TIPOS
============================ */
interface InventoryRow {
  articulo: string;
  descripcion: string;
  unidad: string;
  motivo: string;
  fisico: number;
  teorico: number;
  costo_unitario: number;
  diferencia_unidades: number;
  ajuste_rd: number;
  familia: string;
  clasificacion: string;
}

interface ProcessState {
  progress: number;
  message: string;
  isProcessing: boolean;
  phase: number;
  processingId: number;
}

/* ============================
   COMPONENTE
============================ */
export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [inventoryData, setInventoryData] = useState<InventoryRow[]>([]);
  const [state, setState] = useState<ProcessState>({
    progress: 0,
    message: '',
    isProcessing: false,
    phase: 0,
    processingId: 0
  });
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  /* 🔥 CONTROL TOTAL DE PROCESOS */
  const latestProcessRef = useRef<number>(0);
  const abortRef = useRef<AbortController | null>(null);

  /* ============================
     HELPERS
  ============================ */
  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const cleanNumber = (val: string): number => {
    if (!val) return 0;
    let cleaned = val.replace(/[RD$€£\s,]/g, '');
    if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
      cleaned = '-' + cleaned.slice(1, -1);
    }
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  };

  /* ============================
     PROCESO PRINCIPAL
  ============================ */
  const processPDF = async (pdfFile: File) => {
    /* 🔥 CANCELAR TODO LO ANTERIOR */
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();
    const { signal } = abortRef.current;

    const pId = Date.now();
    latestProcessRef.current = pId;

    /* LIMPIEZA TOTAL */
    setInventoryData([]);
    setFile(null);
    setState({
      progress: 0,
      message: 'Inicializando nuevo documento...',
      isProcessing: true,
      phase: 1,
      processingId: pId
    });

    await new Promise(r => setTimeout(r, 100));

    let pdf: any = null;

    try {
      const arrayBuffer = await pdfFile.arrayBuffer();
      if (signal.aborted) return;

      const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
      pdf = await loadingTask.promise;
      if (signal.aborted) return;

      setFile(pdfFile);

      const totalPages = pdf.numPages;
      let rawRows: string[][] = [];

      /* ============================
         FASE 1 – TEXTO / OCR
      ============================ */
      let textItems = 0;
      const pageData: any[] = [];

      for (let i = 1; i <= totalPages; i++) {
        if (signal.aborted) return;

        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        textItems += textContent.items.length;
        pageData.push(textContent);

        setState(s => ({
          ...s,
          progress: 10 + (i / totalPages) * 20,
          message: `Leyendo página ${i}/${totalPages}`
        }));
      }

      /* OCR SOLO SI ES NECESARIO */
      if (textItems < totalPages * 5) {
        const worker = await createWorker('spa', 1);

        for (let i = 1; i <= totalPages; i++) {
          if (signal.aborted) break;

          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: 1.5 });
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d')!;
          canvas.width = viewport.width;
          canvas.height = viewport.height;

          await page.render({ canvasContext: ctx, viewport }).promise;
          const { data: { text } } = await worker.recognize(canvas);

          text.split('\n').forEach(line => {
            const cols = line.trim().split(/\s{2,}/);
            if (cols.length >= 3) rawRows.push(cols);
          });

          canvas.width = 0;
          canvas.height = 0;

          setState(s => ({
            ...s,
            progress: 30 + (i / totalPages) * 20,
            message: `OCR página ${i}/${totalPages}`
          }));
        }

        await worker.terminate();
      }

      /* ============================
         FASE 2 – PARSEO TABLAS
      ============================ */
      if (rawRows.length === 0) {
        pageData.forEach(tc => {
          tc.items.forEach((it: any) => {
            if (/^\d{3,}/.test(it.str)) {
              rawRows.push([it.str]);
            }
          });
        });
      }

      /* SNAPSHOT INMUTABLE */
      const snapshot = rawRows.map(r => [...r]);

      /* ============================
         FASE 3 – MAPEO CONTABLE
      ============================ */
      const mapped: InventoryRow[] = snapshot.map(r => {
        const nums = r.map(cleanNumber).filter(n => n !== 0);
        return {
          articulo: r[0] || '',
          descripcion: r[1] || '',
          unidad: 'UND',
          motivo: '',
          fisico: nums[0] || 0,
          teorico: nums[1] || 0,
          costo_unitario: nums[2] || 0,
          diferencia_unidades: (nums[0] || 0) - (nums[1] || 0),
          ajuste_rd: ((nums[0] || 0) - (nums[1] || 0)) * (nums[2] || 0),
          familia: 'N/A',
          clasificacion: 'N/A'
        };
      }).filter(r => r.articulo);

      if (signal.aborted) return;

      setInventoryData(mapped);
      setState(s => ({
        ...s,
        progress: 100,
        message: 'Auditoría finalizada',
        isProcessing: false
      }));

      showToast('Auditoría completada exitosamente', 'success');

    } catch (err: any) {
      if (!signal.aborted) {
        console.error(err);
        showToast(err.message || 'Error en auditoría', 'error');
      }
    } finally {
      if (pdf) {
        try { pdf.destroy(); } catch {}
      }
      abortRef.current = null;
    }
  };

  /* ============================
     MANEJO DE ARCHIVO
  ============================ */
  const handleFile = (file: File) => {
    if (file.type !== 'application/pdf') {
      showToast('Solo se permiten archivos PDF', 'error');
      return;
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
    processPDF(file);
  };

  /* ============================
     EXPORTAR EXCEL
  ============================ */
  const downloadExcel = () => {
    if (inventoryData.length === 0) return;

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(inventoryData);
    XLSX.utils.book_append_sheet(wb, ws, 'Ajuste_Contable');
    XLSX.writeFile(wb, 'AUDITORIA_CONTABLE.xlsx');
  };

  const totalAjuste = inventoryData.reduce((a, b) => a + b.ajuste_rd, 0);

  /* ============================
     UI
  ============================ */
  return (
    <div className="min-h-screen bg-slate-50 p-10">
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf"
        hidden
        onChange={e => e.target.files && handleFile(e.target.files[0])}
      />

      {!state.isProcessing && (
        <button
          onClick={() => fileInputRef.current?.click()}
          className="bg-indigo-600 text-white px-6 py-4 rounded-xl font-bold"
        >
          Cargar PDF
        </button>
      )}

      {state.isProcessing && (
        <p className="mt-6 font-bold text-indigo-600">
          {state.message} ({Math.round(state.progress)}%)
        </p>
      )}

      {inventoryData.length > 0 && (
        <>
          <p className="mt-6 font-bold">
            Ajuste Total RD$: {totalAjuste.toLocaleString()}
          </p>

          <button
            onClick={downloadExcel}
            className="mt-4 bg-emerald-600 text-white px-6 py-3 rounded-xl font-bold"
          >
            Descargar Excel
          </button>
        </>
      )}

      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-6 py-3 rounded-xl"
          >
            {toast.message}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
