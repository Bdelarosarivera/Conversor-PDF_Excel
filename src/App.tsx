import React, { useState, useRef, useEffect } from 'react';
import { 
  FileText, 
  Download, 
  RefreshCw, 
  CheckCircle, 
  AlertCircle, 
  X,
  Loader2,
  Calculator,
  TrendingDown,
  TrendingUp,
  DollarSign,
  ShieldCheck,
  Zap
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

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
  librariesLoaded: boolean;
  error: string | null;
}

const LIB_SOURCES = [
  { id: 'pdfjs', src: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js' },
  { id: 'xlsx', src: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js' },
  { id: 'tesseract', src: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.0.3/dist/tesseract.min.js' }
];

export default function App() {
  const [state, setState] = useState<AppState>({
    file: null,
    inventoryData: [],
    progress: 0,
    message: 'Cargando infraestructura...',
    isProcessing: false,
    phase: 0,
    processingId: 0,
    librariesLoaded: false,
    error: null
  });

  const latestProcessRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const loadingTaskRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const loadScript = (lib: { id: string, src: string }) => {
      return new Promise((resolve, reject) => {
        if (document.getElementById(lib.id)) {
          resolve(true);
          return;
        }
        const script = document.createElement('script');
        script.id = lib.id;
        script.src = lib.src;
        script.async = true;
        script.crossOrigin = "anonymous";
        script.onload = () => resolve(true);
        script.onerror = () => reject(`Error cargando ${lib.id}`);
        document.head.appendChild(script);
      });
    };

    Promise.all(LIB_SOURCES.map(loadScript))
      .then(() => {
        if (window.pdfjsLib) {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        }
        setState(prev => ({ ...prev, librariesLoaded: true, message: 'Auditor ERP Listo' }));
      })
      .catch(err => {
        setState(prev => ({ ...prev, error: 'Error de red en librerías críticas.' }));
      });

    return () => {
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, []);

  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
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

  const updateProgress = (progress: number, message: string, pId: number, phase?: number) => {
    if (latestProcessRef.current !== pId) return; // ✅ CAMBIO: Protección contra procesos obsoletos
    setState(prev => prev.processingId === pId ? ({ 
      ...prev, 
      progress, 
      message, 
      phase: phase ?? prev.phase 
    }) : prev);
  };

  const processPDF = async (pdfFile: File, pId: number) => {
    if (abortControllerRef.current) abortControllerRef.current.abort();
    if (loadingTaskRef.current) {
      try { loadingTaskRef.current.destroy(); } catch (e) {}
    }
    
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    let pdf: any = null;
    let worker: any = null; 
    let rawExtraction: any[] = []; 

    try {
      if (signal.aborted || latestProcessRef.current !== pId) return;

      const arrayBuffer = await pdfFile.arrayBuffer();
      const pdfjsLib = (window as any).pdfjsLib;
      
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      loadingTaskRef.current = loadingTask;

      pdf = await loadingTask.promise;
      const totalPages = pdf.numPages;
      
      updateProgress(10, "Extrayendo capas de texto...", pId, 1);

      for (let i = 1; i <= totalPages; i++) {
        if (signal.aborted || latestProcessRef.current !== pId) return;
        
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const items = textContent.items;

        const rowsMap: Map<number, any[]> = new Map();
        items.forEach((item: any) => {
          const y = Math.round(item.transform[5]);
          let foundKey = Array.from(rowsMap.keys()).find(key => Math.abs(key - y) <= 4);
          if (foundKey === undefined) {
            rowsMap.set(y, [item]);
          } else {
            rowsMap.get(foundKey)?.push(item);
          }
        });

        const sortedY = Array.from(rowsMap.keys()).sort((a, b) => b - a);
        sortedY.forEach(y => {
          const rowItems = rowsMap.get(y)?.sort((a, b) => a.transform[4] - b.transform[4]);
          const rowText = rowItems?.map(it => it.str.trim()).filter(s => s.length > 0) || [];
          if (rowText.length >= 3) rawExtraction.push(['DATA', 'N/A', ...rowText]);
        });

        updateProgress(10 + (i / totalPages) * 20, `Escaneando pág ${i}/${totalPages}...`, pId);
      }

      if (rawExtraction.length < totalPages * 2) {
        updateProgress(40, "Iniciando OCR de alta fidelidad...", pId, 2);
        
        // ✅ CAMBIO: Configuración explícita de rutas para evitar errores de Fetch
        worker = await (window as any).Tesseract.createWorker('spa', 1, {
          workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.0.3/dist/worker.min.js',
          langPath: 'https://tessdata.projectnaptha.com/4.0.0',
          corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0/tesseract-core.wasm.js',
          logger: m => {
            if (m.status === 'recognizing') {
              // Actualización sutil de progreso interno
            }
          }
        });
        
        for (let i = 1; i <= totalPages; i++) {
          if (signal.aborted || latestProcessRef.current !== pId) break;
          
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: 2 });
          const canvas = document.createElement('canvas');
          canvas.height = viewport.height;
          canvas.width = viewport.width;
          const context = canvas.getContext('2d');

          if (context) {
            await page.render({ canvasContext: context, viewport }).promise;
            const { data: { text } } = await worker.recognize(canvas);
            
            text.split('\n').forEach(line => {
              const parts = line.trim().split(/\s{2,}/);
              if (parts.length >= 3) rawExtraction.push(['OCR', 'OCR', ...parts]);
            });
          }
          updateProgress(40 + (i / totalPages) * 30, `OCR en curso: pág ${i}/${totalPages}...`, pId);
          canvas.width = 0; canvas.height = 0; 
        }
      }

      if (signal.aborted || latestProcessRef.current !== pId) return;
      updateProgress(80, "Verificando integridad contable...", pId, 3);

      const processedData: InventoryRow[] = rawExtraction.map(row => {
        const articulo = row[2] || '';
        const descripcion = row[3] || '';
        const nums = row.slice(4).map(s => cleanNumber(s)).filter(n => n !== 0);
        const fis = nums[0] || 0;
        const teo = nums[1] || 0;
        const cos = nums[2] || 0;
        const dif = fis - teo;

        return {
          articulo, descripcion, unidad: 'UND', motivo: '01',
          fisico: fis, teorico: teo, costo_unitario: cos, diferencia_unidades: dif,
          fisico_rd: fis * cos, teorico_rd: teo * cos, ajuste_rd: dif * cos,
          familia: row[0], clasificacion: row[1]
        };
      }).filter(r => r.articulo.length > 2 && r.costo_unitario > 0);

      if (latestProcessRef.current === pId) {
        // ✅ CAMBIO: Clonación profunda para asegurar inmutabilidad
        const immutableResult = JSON.parse(JSON.stringify(processedData));
        setState(prev => prev.processingId === pId ? ({
          ...prev,
          inventoryData: immutableResult,
          isProcessing: false,
          progress: 100,
          message: "Auditoría Finalizada",
          phase: 4
        }) : prev);
        showToast("Reporte analizado con éxito.");
      }

    } catch (err: any) {
      if (!signal.aborted && latestProcessRef.current === pId) {
        showToast("Fallo en el procesamiento del PDF", "error");
        setState(prev => ({ ...prev, isProcessing: false, message: 'Error en proceso' }));
      }
    } finally {
      if (worker) await worker.terminate();
      if (pdf) await pdf.destroy();
      rawExtraction = []; 
    }
  };

  const handleFile = (file: File) => {
    if (!state.librariesLoaded) return;
    const pId = Date.now();
    latestProcessRef.current = pId;
    
    // ✅ CAMBIO: Reset total para evitar mezcla de datos visuales
    setState(prev => ({
      ...prev,
      file,
      inventoryData: [],
      isProcessing: true,
      progress: 0,
      message: 'Limpiando entorno para nuevo análisis...',
      processingId: pId,
      phase: 1
    }));

    if (fileInputRef.current) fileInputRef.current.value = '';
    setTimeout(() => processPDF(file, pId), 100);
  };

  const downloadExcel = () => {
    if (!state.inventoryData.length || !(window as any).XLSX) return;
    const XLSX = (window as any).XLSX;
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(state.inventoryData);
    XLSX.utils.book_append_sheet(wb, ws, "Auditoria");
    XLSX.writeFile(wb, `REPORTE_AJUSTE_${state.processingId}.xlsx`);
  };

  const totalAjuste = state.inventoryData.reduce((acc, curr) => acc + curr.ajuste_rd, 0);

  return (
    <div className="min-h-screen bg-[#f8fafc] text-slate-900 font-sans p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        
        {/* Header */}
        <header className="flex flex-col md:flex-row items-center justify-between mb-10 gap-6">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 bg-indigo-600 rounded-2xl flex items-center justify-center text-white shadow-xl rotate-2">
              <Calculator size={30} />
            </div>
            <div>
              <h1 className="text-3xl font-black tracking-tighter text-slate-900 uppercase">
                Auditor <span className="text-indigo-600">ERP</span>
              </h1>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Aislamiento de Datos v3.0</p>
            </div>
          </div>
          
          <div className="flex gap-4">
            <div className="bg-white px-5 py-3 rounded-2xl shadow-sm border border-slate-200">
              <span className="block text-[10px] font-black text-slate-400 uppercase tracking-tighter mb-1">Motor AI / OCR</span>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${state.librariesLoaded ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
                <span className="text-xs font-black uppercase">{state.librariesLoaded ? 'Conectado' : 'Cargando...'}</span>
              </div>
            </div>
          </div>
        </header>

        {/* Workspace Card */}
        <main className="bg-white rounded-[2.5rem] shadow-2xl shadow-indigo-100/50 border border-slate-200 overflow-hidden min-h-[450px]">
          {!state.isProcessing && state.inventoryData.length === 0 ? (
            <div 
              className="p-20 text-center cursor-pointer hover:bg-slate-50/50 transition-all group"
              onClick={() => fileInputRef.current?.click()}
            >
              <input type="file" ref={fileInputRef} className="hidden" accept=".pdf" onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
              <div className="w-24 h-24 bg-indigo-50 text-indigo-600 rounded-3xl flex items-center justify-center mx-auto mb-8 group-hover:scale-110 group-hover:bg-indigo-600 group-hover:text-white transition-all duration-500 shadow-sm">
                <FileText size={44} />
              </div>
              <h2 className="text-3xl font-black text-slate-800 mb-3">Subir Reporte de Inventario</h2>
              <p className="text-slate-400 font-medium max-w-sm mx-auto text-lg leading-relaxed">
                Importe su PDF para detección automática de discrepancias y cálculos de ajuste neto.
              </p>
              <div className="mt-10 flex justify-center gap-4">
                <div className="px-5 py-2 bg-slate-100 rounded-full text-[10px] font-black text-slate-500 uppercase tracking-widest">OCR Fetch-Fixed</div>
                <div className="px-5 py-2 bg-slate-100 rounded-full text-[10px] font-black text-slate-500 uppercase tracking-widest">Secure Isolation</div>
              </div>
            </div>
          ) : state.isProcessing ? (
            <div className="py-32 flex flex-col items-center justify-center">
              <div className="relative mb-10">
                <Loader2 size={72} className="text-indigo-600 animate-spin" strokeWidth={3} />
                <div className="absolute inset-0 flex items-center justify-center text-xs font-black text-indigo-600">
                  {Math.round(state.progress)}%
                </div>
              </div>
              <h3 className="text-2xl font-black text-slate-800 uppercase tracking-tight mb-2">{state.message}</h3>
              <p className="text-slate-400 text-[10px] font-bold uppercase tracking-[0.3em]">El análisis es local y seguro</p>
            </div>
          ) : (
            <div className="p-8 md:p-12 animate-in fade-in slide-in-from-bottom-4 duration-700">
              <div className="flex flex-col md:flex-row justify-between items-center mb-10 gap-6 border-b border-slate-100 pb-10">
                <div className="flex items-center gap-5">
                  <div className="p-4 bg-indigo-600 rounded-2xl text-white shadow-lg shadow-indigo-200">
                    <ShieldCheck size={28} />
                  </div>
                  <div>
                    <h4 className="text-lg font-black text-slate-900 uppercase leading-none mb-1">{state.inventoryData.length} SKUs Auditados</h4>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">ID Sesión: {state.processingId}</p>
                  </div>
                </div>
                
                <div className="flex gap-4 w-full md:w-auto">
                  <button 
                    onClick={downloadExcel}
                    className="flex-1 md:flex-none flex items-center justify-center gap-3 bg-slate-900 text-white px-8 py-4 rounded-2xl font-black text-xs hover:bg-slate-800 transition-all shadow-xl hover:-translate-y-1 active:translate-y-0"
                  >
                    <Download size={18} /> EXPORTAR EXCEL
                  </button>
                  <button 
                    onClick={() => setState(prev => ({...prev, inventoryData: [], file: null}))}
                    className="p-4 bg-white border border-slate-200 rounded-2xl text-slate-400 hover:text-rose-600 hover:border-rose-100 hover:bg-rose-50 transition-all shadow-sm"
                    title="Nueva Auditoría"
                  >
                    <RefreshCw size={22} />
                  </button>
                </div>
              </div>

              {/* KPI Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
                <div className="bg-indigo-600 p-8 rounded-[2rem] text-white shadow-2xl shadow-indigo-200 relative overflow-hidden group">
                  <div className="absolute -right-4 -bottom-4 text-white/10 rotate-12 group-hover:scale-110 transition-transform">
                    <DollarSign size={120} />
                  </div>
                  <span className="text-[10px] font-black uppercase opacity-60 tracking-[0.2em] mb-4 block">Impacto Neto en Inventario</span>
                  <div className="text-4xl font-black flex items-center gap-2">
                    RD$ {totalAjuste.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </div>
                </div>
                
                <div className="bg-emerald-50 p-8 rounded-[2rem] border border-emerald-100 group">
                  <div className="flex justify-between items-start mb-4">
                    <span className="text-[10px] font-black text-emerald-600 uppercase tracking-[0.2em]">Sobrantes</span>
                    <TrendingUp className="text-emerald-500" size={24} />
                  </div>
                  <div className="text-4xl font-black text-emerald-700">
                    {state.inventoryData.filter(i => i.ajuste_rd > 0).length}
                  </div>
                </div>

                <div className="bg-rose-50 p-8 rounded-[2rem] border border-rose-100 group">
                  <div className="flex justify-between items-start mb-4">
                    <span className="text-[10px] font-black text-rose-600 uppercase tracking-[0.2em]">Faltantes</span>
                    <TrendingDown className="text-rose-500" size={24} />
                  </div>
                  <div className="text-4xl font-black text-rose-700">
                    {state.inventoryData.filter(i => i.ajuste_rd < 0).length}
                  </div>
                </div>
              </div>

              {/* Data Table */}
              <div className="overflow-x-auto rounded-[1.5rem] border border-slate-100 shadow-sm">
                <table className="w-full text-left text-sm border-collapse">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-100">
                      <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Artículo / Código</th>
                      <th className="px-8 py-5 text-right text-[10px] font-black text-slate-400 uppercase tracking-widest">Físico</th>
                      <th className="px-8 py-5 text-right text-[10px] font-black text-slate-400 uppercase tracking-widest">Teórico</th>
                      <th className="px-8 py-5 text-right text-[10px] font-black text-slate-400 uppercase tracking-widest">Ajuste (RD$)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {state.inventoryData.map((row, idx) => (
                      <tr key={`${state.processingId}-${idx}`} className="hover:bg-indigo-50/30 transition-colors group">
                        <td className="px-8 py-5">
                          <div className="font-black text-slate-900 group-hover:text-indigo-600 transition-colors">{row.articulo}</div>
                          <div className="text-[10px] text-slate-400 font-bold uppercase truncate max-w-[250px]">{row.descripcion}</div>
                        </td>
                        <td className="px-8 py-5 text-right font-mono font-bold text-slate-700">{row.fisico}</td>
                        <td className="px-8 py-5 text-right font-mono text-slate-400 font-medium">{row.teorico}</td>
                        <td className={`px-8 py-5 text-right font-black ${row.ajuste_rd < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                          {row.ajuste_rd >= 0 ? '+' : ''}{row.ajuste_rd.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </main>

        {/* Footer */}
        <footer className="mt-10 flex flex-col md:flex-row justify-between items-center gap-4 px-6 opacity-40">
          <p className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400">Auditor Contable ERP Module © 2024</p>
          <div className="flex gap-6 text-slate-500">
            <Zap size={18} />
            <ShieldCheck size={18} />
          </div>
        </footer>
      </div>

      {/* Toast System */}
      <AnimatePresence>
        {toast && (
          <motion.div 
            initial={{ y: 80, opacity: 0, scale: 0.9 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 20, opacity: 0, scale: 0.9 }}
            className={`fixed bottom-10 left-1/2 -translate-x-1/2 px-8 py-4 rounded-[1.5rem] shadow-2xl flex items-center gap-4 font-black text-xs text-white z-50 ${toast.type === 'error' ? 'bg-rose-600' : 'bg-slate-900'}`}
          >
            {toast.type === 'error' ? <AlertCircle size={20} /> : <CheckCircle size={20} />}
            <span className="uppercase tracking-widest">{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
