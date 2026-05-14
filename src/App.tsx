import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  FileText, 
  Download, 
  RefreshCw, 
  CheckCircle, 
  AlertCircle, 
  X,
  Loader2,
  Table as TableIcon,
  Calculator,
  ClipboardList,
  FileSpreadsheet,
  TrendingDown,
  TrendingUp,
  DollarSign
} from 'lucide-react';


// Interfaces de datos
interface InventoryRow {
  articulo: string;
  descripcion: string;
  unidad: string;
  motivo: string;
  fisico: number;
  teorico: number;
  costo_unitario: number;
  diferencia_unidades: number;
  fisico_rd: number;
  teorico_rd: number;
  ajuste_rd: number;
  familia: string;
  clasificacion: string;
}

interface AppState {
  file: File | null;
  inventoryData: InventoryRow[];
  progress: number;
  message: string;
  isProcessing: boolean;
  phase: number;
  processingId: number;
  libsLoaded: boolean;
}


// Función para cargar scripts dinámicamente
const loadScript = (src: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = reject;
    document.head.appendChild(script);
  });
};

export default function App() {
  const [state, setState] = useState<AppState>({
    file: null,
    inventoryData: [],
    progress: 0,
    message: 'Inicializando motor...',
    isProcessing: false,
    phase: 0,
    processingId: 0,
    libsLoaded: false
  });

  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const latestProcessRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  
  useEffect(() => {
    const initLibs = async () => {
      try {
        await Promise.all([
          loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'),
          loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'),
          loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'),
          loadScript('https://cdn.jsdelivr.net/npm/framer-motion@11.11.17/dist/framer-motion.js')
        ]);
        
        // Configurar worker de PDF.js
        if ((window as any).pdfjsLib) {
          (window as any).pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        }
        
        setState(prev => ({ ...prev, libsLoaded: true, message: 'Listo para procesar' }));
      } catch (err) {
        showToast("Error al cargar librerías críticas.", "error");
      }
    };
    initLibs();
  }, []);

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const updateProgress = (progress: number, message: string, pId: number, phase?: number) => {
    if (latestProcessRef.current !== pId) return;
    setState(prev => prev.processingId === pId ? ({ 
      ...prev, 
      progress, 
      message, 
      phase: phase ?? prev.phase 
    }) : prev);
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


  const processPDF = async (pdfFile: File, pId: number) => {
    const pdfjsLib = (window as any).pdfjsLib;
    const XLSX = (window as any).XLSX;
    const Tesseract = (window as any).Tesseract;

    if (!pdfjsLib || !XLSX || !Tesseract) {
      showToast("Librerías no cargadas correctamente.", "error");
      return;
    }

    if (abortControllerRef.current) abortControllerRef.current.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    try {
      updateProgress(5, "Leyendo archivo PDF...", pId, 1);
      const arrayBuffer = await pdfFile.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      
      const totalPages = pdf.numPages;
      let rawDataRows: string[][] = [];
      let currentFamilia = 'N/A';
      let currentClasificacion = 'N/A';

      
      for (let i = 1; i <= totalPages; i++) {
        if (signal.aborted || latestProcessRef.current !== pId) return;
        
        updateProgress(10 + (i / totalPages) * 30, `Analizando página ${i} de ${totalPages}...`, pId);
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const items = textContent.items as any[];
        
        // Agrupar por líneas (Y coordinada con tolerancia)
        const rows: any[] = [];
        items.forEach(item => {
          const y = item.transform[5];
          let foundRow = rows.find(r => Math.abs(r.y - y) <= 4);
          if (!foundRow) {
            foundRow = { y, items: [] };
            rows.push(foundRow);
          }
          foundRow.items.push(item);
        });

        // Ordenar y procesar líneas
        rows.sort((a, b) => b.y - a.y).forEach(row => {
          const sortedItems = row.items.sort((a: any, b: any) => a.transform[4] - b.transform[4]);
          const lineText = sortedItems.map((it: any) => it.str).join(' ').trim();
          
          // Detección simple de encabezados de familia/clase
          if (/^[A-Z0-9\s]{5,40}$/.test(lineText) && !lineText.includes('Página') && sortedItems.length < 3) {
            currentFamilia = lineText;
          }

          // Detección de fila de artículo (empieza con código numérico)
          const firstToken = sortedItems[0]?.str.trim();
          if (/^\d{3,15}$/.test(firstToken)) {
            const cells = sortedItems.map((it: any) => it.str.trim()).filter(s => s.length > 0);
            if (cells.length >= 4) {
              rawDataRows.push([currentFamilia, currentClasificacion, ...cells]);
            }
          }
        });
      }


      updateProgress(70, "Mapeando columnas y verificando costos...", pId, 3);
      
      const mapped = rawDataRows.map(raw => {
        const data = raw.slice(2);
        const articulo = data[0];
        const desc = data[1];
        
        // Búsqueda heurística de valores numéricos
        const nums = data.slice(2).map(v => cleanNumber(v)).filter(n => !isNaN(n));
        
        let fis = 0, teo = 0, cos = 0;
        if (nums.length >= 3) {
          fis = nums[0];
          teo = nums[1];
          cos = nums[2];
        }

        const dif = fis - teo;
        const aj = dif * cos;

        return {
          articulo, descripcion: desc, unidad: 'UND', motivo: '',
          fisico: fis, teorico: teo, costo_unitario: cos,
          diferencia_unidades: dif, fisico_rd: 0, teorico_rd: 0, ajuste_rd: aj,
          familia: raw[0], clasificacion: raw[1]
        };
      }).filter(r => r.articulo);

      if (signal.aborted || latestProcessRef.current !== pId) return;

      setState(prev => prev.processingId === pId ? {
        ...prev,
        inventoryData: mapped,
        isProcessing: false,
        progress: 100,
        message: "Auditoría Finalizada"
      } : prev);
      
      showToast("Procesamiento completado.", "success");

    } catch (err) {
      if (!signal.aborted) {
        console.error(err);
        showToast("Error procesando el documento.", "error");
        setState(prev => ({ ...prev, isProcessing: false }));
      }
    }
  };

  const handleFile = (file: File) => {
    if (!state.libsLoaded) return;
    const pId = Date.now();
    latestProcessRef.current = pId;
    
    setState(prev => ({
      ...prev,
      file,
      inventoryData: [],
      isProcessing: true,
      progress: 0,
      message: 'Iniciando análisis...',
      processingId: pId
    }));

    processPDF(file, pId);
  };


  const downloadExcel = () => {
    const XLSX = (window as any).XLSX;
    if (!XLSX || state.inventoryData.length === 0) return;

    const wb = XLSX.utils.book_new();
    const wsData = state.inventoryData.map(i => ({
      'Articulo': i.articulo,
      'Descripcion': i.descripcion,
      'Fisico': i.fisico,
      'Teorico': i.teorico,
      'Diferencia': i.diferencia_unidades,
      'Costo': i.costo_unitario,
      'Ajuste RD$': i.ajuste_rd,
      'Familia': i.familia
    }));

    const ws = XLSX.utils.json_to_sheet(wsData);
    XLSX.utils.book_append_sheet(wb, ws, "Auditoria");
    XLSX.writeFile(wb, `Auditoria_Inventario_${new Date().getTime()}.xlsx`);
  };


  const MotionDiv = (window as any).Motion?.motion?.div || 'div';
  const AnimatePresence = (window as any).Motion?.AnimatePresence || React.Fragment;

  return (
    <div className="min-h-screen bg-slate-50 p-6 md:p-12 font-sans selection:bg-indigo-100">
      <div className="max-w-6xl mx-auto">
        
        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-center mb-12 gap-6">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 bg-indigo-600 rounded-lg text-white">
                <Calculator className="w-6 h-6" />
              </div>
              <h1 className="text-3xl font-black text-slate-900 tracking-tight uppercase">
                Auditor <span className="text-indigo-600 underline decoration-indigo-100 decoration-4 underline-offset-4">Contable</span>
              </h1>
            </div>
            <p className="text-slate-500 font-bold text-sm tracking-wide">ERP Integration & Stock Sync Module</p>
          </div>
          
          <div className="bg-white border border-slate-200 px-5 py-3 rounded-2xl shadow-sm">
            <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Estado del Motor</div>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full animate-pulse ${state.libsLoaded ? 'bg-emerald-500' : 'bg-amber-500'}`} />
              <span className="text-xs font-bold text-slate-700">{state.libsLoaded ? 'Sistemas Operativos' : 'Cargando Núcleo...'}</span>
            </div>
          </div>
        </header>

        {/* Content Area */}
        <main className="bg-white rounded-[2.5rem] shadow-xl shadow-slate-200/50 border border-slate-200/60 overflow-hidden min-h-[400px]">
          {!state.file && !state.isProcessing ? (
            <div 
              onClick={() => state.libsLoaded && fileInputRef.current?.click()}
              className={`p-20 text-center cursor-pointer transition-all ${!state.libsLoaded ? 'opacity-50 grayscale' : 'hover:bg-slate-50'}`}
            >
              <input type="file" ref={fileInputRef} className="hidden" accept=".pdf" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
              <div className="w-24 h-24 bg-slate-900 text-white rounded-3xl flex items-center justify-center mx-auto mb-8 shadow-xl">
                <FileText className="w-10 h-10" />
              </div>
              <h3 className="text-2xl font-black text-slate-900 mb-2">Procesar Inventario</h3>
              <p className="text-slate-400 font-bold max-w-xs mx-auto">Arrastre su reporte PDF de inventario SAP/ERP aquí</p>
            </div>
          ) : state.isProcessing ? (
            <div className="py-32 flex flex-col items-center justify-center space-y-8">
              <div className="relative">
                <Loader2 className="w-16 h-16 text-indigo-600 animate-spin" />
                <div className="absolute inset-0 flex items-center justify-center text-[10px] font-black text-indigo-600">
                  {Math.round(state.progress)}%
                </div>
              </div>
              <div className="text-center">
                <h4 className="text-xl font-black text-slate-900">{state.message}</h4>
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-2">Analizando estructuras contables</p>
              </div>
            </div>
          ) : (
            <div className="p-8">
              <div className="flex justify-between items-center mb-8 bg-slate-50 p-6 rounded-2xl border border-slate-100">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-indigo-100 text-indigo-600 rounded-xl flex items-center justify-center">
                    <TableIcon className="w-6 h-6" />
                  </div>
                  <div>
                    <h4 className="font-black text-slate-900">{state.inventoryData.length} Artículos Detectados</h4>
                    <p className="text-xs text-slate-400 font-bold uppercase">{state.file?.name}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={downloadExcel} className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white rounded-xl font-bold text-sm hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200">
                    <Download className="w-4 h-4" /> Exportar Excel
                  </button>
                  <button onClick={() => setState(prev => ({...prev, file: null, inventoryData: []}))} className="p-2.5 text-slate-400 hover:text-rose-500">
                    <X className="w-6 h-6" />
                  </button>
                </div>
              </div>

              <div className="overflow-hidden border border-slate-100 rounded-2xl">
                <table className="w-full text-left">
                  <thead className="bg-slate-50 text-[10px] font-black text-slate-400 uppercase tracking-widest">
                    <tr>
                      <th className="px-6 py-4">Artículo</th>
                      <th className="px-6 py-4 text-right">Físico</th>
                      <th className="px-6 py-4 text-right">Teórico</th>
                      <th className="px-6 py-4 text-right">Ajuste RD$</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {state.inventoryData.map((row, idx) => (
                      <tr key={idx} className="hover:bg-slate-50/50 transition-colors">
                        <td className="px-6 py-4">
                          <div className="font-bold text-slate-900 text-sm">{row.articulo}</div>
                          <div className="text-[10px] text-slate-400 font-bold uppercase truncate max-w-[200px]">{row.descripcion}</div>
                        </td>
                        <td className="px-6 py-4 text-right font-bold text-sm">{row.fisico}</td>
                        <td className="px-6 py-4 text-right font-bold text-sm text-slate-400">{row.teorico}</td>
                        <td className={`px-6 py-4 text-right font-black text-sm ${row.ajuste_rd < 0 ? 'text-rose-600' : row.ajuste_rd > 0 ? 'text-emerald-600' : 'text-slate-400'}`}>
                          {row.ajuste_rd.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </main>

        <footer className="mt-8 flex justify-between items-center px-6 opacity-60">
           <div className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex gap-4">
              <span>PDF.JS Core</span>
              <span>Tesseract OCR</span>
              <span>In-Browser Processing</span>
           </div>
           <p className="text-[10px] font-bold text-slate-400 uppercase">AuditSystem Pro © 2024</p>
        </footer>
      </div>

      {/* Simple Toast Placeholder */}
      {toast && (
        <div className={`fixed bottom-8 left-1/2 -translate-x-1/2 px-6 py-4 rounded-2xl shadow-2xl z-50 text-white font-bold text-sm border flex items-center gap-3 animate-bounce
          ${toast.type === 'error' ? 'bg-rose-600 border-rose-500' : 'bg-emerald-600 border-emerald-500'}`}>
          {toast.type === 'error' ? <AlertCircle className="w-5 h-5" /> : <CheckCircle className="w-5 h-5" />}
          {toast.message}
        </div>
      )}
    </div>
  );
}
