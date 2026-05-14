import { useState, useRef, useCallback, DragEvent } from 'react';
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
import { motion, AnimatePresence } from 'motion/react';
import * as pdfjs from 'pdfjs-dist';
import * as XLSX from 'xlsx';
import { createWorker } from 'tesseract.js';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;

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

interface FormularioAjuste {
  fecha: string;
  realizadoPor: string;
  areas: string;
  motivo: string;
  problemas: string;
  planAccion: string;
}

interface ProcessState {
  progress: number;
  message: string;
  isProcessing: boolean;
  phase: number;
  rawPageTexts: Record<string, string>;
}

interface AppState extends ProcessState {
  file: File | null;
  inventoryData: InventoryRow[];
  processingId: number;
}

export default function App() {
  const [state, setState] = useState<AppState>({
    file: null,
    inventoryData: [],
    progress: 0,
    message: '',
    isProcessing: false,
    phase: 0,
    rawPageTexts: {},
    processingId: 0
  });

  // ✅ CAMBIO: AbortController ref reemplaza latestProcessRef para cancelación real
  const abortControllerRef = useRef<AbortController | null>(null);
  
  const [formulario, setFormulario] = useState<FormularioAjuste>({
    fecha: new Date().toLocaleDateString(),
    realizadoPor: 'Generado por Sistema',
    areas: 'General',
    motivo: 'Cuadre de Inventario',
    problemas: 'N/A',
    planAccion: 'Sincronización de stock'
  });

  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const updateProgress = (progress: number, message: string, phase?: number) => {
    setState(prev => ({ ...prev, progress, message, phase: phase ?? prev.phase }));
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

  const processPDF = async (pdfFile: File) => {
    // ✅ CAMBIO: Abortar proceso anterior de forma real antes de comenzar
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // ✅ CAMBIO: Nuevo AbortController exclusivo para esta ejecución
    const controller = new AbortController();
    const signal = controller.signal;
    abortControllerRef.current = controller;

    const pId = Date.now();

    // ✅ CAMBIO: Reset atómico completo — ninguna referencia al estado anterior sobrevive
    setState({ 
      file: null,
      inventoryData: [],
      isProcessing: true, 
      progress: 0, 
      message: 'PURGANDO CACHÉ Y DATOS ANTERIORES...',
      phase: 1,
      rawPageTexts: {}, 
      processingId: pId
    });

    let pdf: any = null;
    let worker: any = null; 

    try {
      await new Promise(r => setTimeout(r, 500));
      // ✅ CAMBIO: Validar signal.aborted en todos los puntos de suspensión
      if (signal.aborted) return;

      const arrayBuffer = await pdfFile.arrayBuffer();
      if (signal.aborted) return;

      const loadingTask = pdfjs.getDocument({ 
        data: arrayBuffer,
        cMapUrl: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/cmaps/`,
        cMapPacked: true,
      });

      pdf = await loadingTask.promise;
      if (signal.aborted) return;
      
      const totalPages = pdf.numPages;
      setState(prev => ({ ...prev, file: pdfFile }));
      
      // ===============================================
      // FASE 1 – LECTURA Y OCR
      // ===============================================
      // ✅ CAMBIO: Arrays locales nuevos por ejecución — sin referencias compartidas
      const pageTexts: Record<string, string> = {};
      // ✅ CAMBIO: pageData clonado como array nuevo aislado de esta ejecución
      const pageData: any[] = [];
      let totalTextItems = 0;
      
      updateProgress(10, "FASE 1: Extrayendo texto crudo por página...", 1);
      for (let i = 1; i <= totalPages; i++) {
        // ✅ CAMBIO: signal.aborted verificado en cada iteración crítica
        if (signal.aborted) return;
        
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const rawText = textContent.items.map((it: any) => it.str).join(' ');
        pageTexts[`pagina_${i}`] = rawText;
        // ✅ CAMBIO: Clonar deep el textContent antes de acumular para evitar referencias vivas
        pageData.push(JSON.parse(JSON.stringify(textContent)));
        totalTextItems += textContent.items.length;
        updateProgress(10 + (i / totalPages) * 15, `Leyendo texto pág ${i}/${totalPages}...`);
      }

      // ✅ CAMBIO: Array OCR nuevo e inmutable para esta ejecución
      let ocrDataRows: string[][] = [];
      if (totalTextItems < totalPages * 5) { 
        updateProgress(25, "Iniciando motor OCR de alta precisión...", 1);
        
        try {
          worker = await createWorker('spa', 1);
          for (let i = 1; i <= totalPages; i++) {
            // ✅ CAMBIO: signal.aborted verificado antes de cada página OCR
            if (signal.aborted) break;
            
            updateProgress(25 + ((i - 0.7) / totalPages) * 15, `Preparando análisis OCR pág ${i}/${totalPages}...`, 1);
            
            const page = await pdf.getPage(i);
            const scale = 1.5; 
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.height = viewport.height;
            canvas.width = viewport.width;

            if (context) {
              await page.render({ canvasContext: context as any, viewport: viewport } as any).promise;
              // ✅ CAMBIO: signal.aborted verificado tras renderizado del canvas
              if (signal.aborted) {
                canvas.width = 0;
                canvas.height = 0;
                break;
              }

              updateProgress(25 + ((i - 0.3) / totalPages) * 15, `Escaneando caracteres pág ${i}/${totalPages}...`, 1);
              
              const { data: { text } } = await worker.recognize(canvas);
              
              // ✅ CAMBIO: signal.aborted verificado tras OCR asíncrono antes de escribir
              if (signal.aborted) {
                canvas.width = 0;
                canvas.height = 0;
                break;
              }

              pageTexts[`pagina_${i}`] = text;
              const lines = text.split('\n');
              lines.forEach(line => {
                const row = line.trim().split(/\s{2,}/);
                if (row.length >= 3 && row[0].length > 1) {
                  // ✅ CAMBIO: Push con spread para evitar referencia directa al array de split
                  ocrDataRows.push(['OCR', 'OCR', ...row.map(s => String(s))]);
                }
              });
            }
            canvas.width = 0;
            canvas.height = 0;
          }
        } catch (ocrError) {
          console.error("OCR Failure:", ocrError);
        } finally {
          // ✅ CAMBIO: Terminar worker siempre, independientemente de cancelación
          if (worker) {
            await worker.terminate();
            worker = null;
          }
        }
      }
      
      // ✅ CAMBIO: Verificar signal antes de escribir estado con textos extraídos
      if (signal.aborted) return;

      // ✅ CAMBIO: Snapshot inmutable del mapa de textos — clonado profundo
      setState(prev => ({ ...prev, rawPageTexts: JSON.parse(JSON.stringify(pageTexts)) }));

      // ===============================================
      // FASE 2 – DETECCIÓN DE TABLAS
      // ===============================================
      updateProgress(40, "FASE 2: Identificando estructuras de tabla...", 2);

      // ✅ CAMBIO: rawDataRows es un array nuevo creado a partir de copia superficial de ocrDataRows
      let rawDataRows: string[][] = ocrDataRows.length > 0
        ? ocrDataRows.map(row => [...row])  // ✅ CAMBIO: clonar cada fila para evitar referencia compartida
        : [];

      let currentFamilia = 'N/A';
      let currentClasificacion = 'N/A';
      const ROW_TOLERANCE = 3;

      if (ocrDataRows.length === 0) {
        for (let i = 0; i < totalPages; i++) {
          // ✅ CAMBIO: signal.aborted verificado en cada página de fase 2
          if (signal.aborted) return;
          
          await new Promise(r => setTimeout(r, 10));
          // ✅ CAMBIO: pageData[i] es ya un clon deep — acceso seguro sin mutar el original
          const textContent = pageData[i];
          const rows: { y: number; items: any[] }[] = [];
          
          textContent.items.forEach((item: any) => {
            if ('transform' in item) {
              const y = item.transform[5];
              let foundRow = rows.find(r => Math.abs(r.y - y) <= ROW_TOLERANCE);
              if (!foundRow) foundRow = { y: y, items: [] }, rows.push(foundRow);
              foundRow.items.push(item);
            }
          });

          rows.sort((a, b) => b.y - a.y).forEach(row => {
            const items = row.items.sort((a, b) => a.transform[4] - b.transform[4]);
            if (items.length === 0) return;

            const fullLine = items.map(it => it.str).join(' ').trim();
            const hasUnit = /^(UD|PCS|CAJA|KG|LBS|GR|UNID|UND)$/i.test(fullLine) || items.some(it => /^(UD|PCS|CAJA|KG|LBS|GR|UNID|UND)$/i.test(it.str.trim()));

            if (/^\d+\s+[A-Z\s]{4,}/.test(fullLine) && !hasUnit && items.length < 8) {
               const cleaned = fullLine.replace(/User|Fecha|Hora/gi, '').trim();
               if (cleaned.length > 5 && !/^\d{4,}/.test(cleaned)) { 
                 if (currentFamilia === 'N/A') currentFamilia = cleaned;
                 else currentClasificacion = cleaned;
                 return;
               }
            }

            const firstToken = items[0].str.trim();
            const isPotentialArticle = /^\d{2,12}$/.test(firstToken) || (items.length === 1 && /^\d{4,}\s+/.test(firstToken));
            
            if (isPotentialArticle && !fullLine.includes('Total General')) {
              let rowData: string[] = [];
              
              if (items.length === 1 && firstToken.includes('  ')) {
                rowData = firstToken.split(/\s{2,}/).filter(s => s.length > 0);
              } else {
                let currentCell = items[0].str;
                let lastX = items[0].transform[4] + (items[0].width || 0);

                for (let j = 1; j < items.length; j++) {
                  const it = items[j];
                  const gap = it.transform[4] - lastX;
                  if (gap > (it.height || 8) * 0.35) { 
                    rowData.push(currentCell.trim());
                    currentCell = it.str;
                  } else {
                    currentCell += (currentCell.endsWith(' ') ? '' : ' ') + it.str;
                  }
                  lastX = it.transform[4] + (it.width || 0);
                }
                rowData.push(currentCell.trim());
              }

              if (rowData.length >= 3) {
                const numCount = rowData.filter(s => /[0-9]/.test(s)).length;
                if (numCount >= 2 || rowData[0].length > 4) {
                  // ✅ CAMBIO: Push con copia explícita de cada celda como string primitivo
                  rawDataRows.push([
                    String(currentFamilia),
                    String(currentClasificacion),
                    ...rowData.map(s => String(s))
                  ]);
                }
              }
            }
          });
          updateProgress(40 + (i / totalPages) * 10, `Detectando tablas pág ${i+1}...`);
        }
      }

      // ===============================================
      // FASE 3 – MAPEO ESTRICTO DE COLUMNAS
      // ===============================================
      if (signal.aborted) return;
      updateProgress(60, "FASE 3: Aplicando mapeo estricto de columnas contables...", 3);

      // ✅ CAMBIO: Snapshot inmutable de rawDataRows antes del mapeo — sin referencia al array original
      const rawDataSnapshot: string[][] = rawDataRows.map(row => [...row]);

      const mapped = rawDataSnapshot.map(raw => {
        const fam = raw[0];
        const clas = raw[1];
        const data = raw.slice(2);
        
        const articulo = data[0] || '';
        const descripcion = data[1] || '';
        const unidad = data.find(c => /^(UD|PCS|CAJA|KG|LBS|GR|UNID|UND)$/i.test(c.trim())) || 'UND';
        const motivo = data.find(c => /^\d{2}$/.test(c.trim()) && c !== articulo) || '';
        
        const allNumbers = data.slice(2)
          .map(c => ({ original: c, value: cleanNumber(c), isUnit: /^(UD|PCS|CAJA|KG|LBS|GR|UNID|UND)$/i.test(c.trim()) }))
          .filter(obj => !obj.isUnit)
          .map(obj => obj.value)
          .filter((v, idx) => v !== 0 || /^[0]$/.test(data.slice(2)[idx]?.trim() || ""));

        let fis = 0, teo = 0, cos = 0, dif = 0, fisRD = 0, teoRD = 0, ajRD = 0;
        let motVal = motivo ? cleanNumber(motivo) : (allNumbers[0] || 0);
        
        const nums = allNumbers.filter(n => Math.abs(n - cleanNumber(articulo)) > 0.1 || n === 29 || n === 19);

        if (nums.length >= 3) {
          const costoIdx = nums.findIndex((v, i) => i > 0 && (Math.abs(v % 1) > 0.001 || (v > 100 && i < 5)));
          
          if (costoIdx === 2) {
            teo = nums[1]; cos = nums[2]; dif = nums[3] || 0;
            fisRD = nums[4] || 0; teoRD = nums[5] || 0; ajRD = nums[6] || 0;
          } else if (costoIdx >= 3) {
            fis = nums[1]; teo = nums[2]; cos = nums[3]; dif = nums[4] || 0;
            fisRD = nums[5] || 0; teoRD = nums[6] || 0; ajRD = nums[7] || 0;
          } else {
            fis = nums[1] || 0; teo = nums[2] || 0; cos = nums[3] || 0;
            dif = nums[4] || 0; fisRD = nums[5] || 0; teoRD = nums[6] || 0; ajRD = nums[7] || 0;
          }
        }

        return {
          articulo, descripcion, unidad, motivo: motVal.toString(),
          fisico: fis, teorico: teo, costo_unitario: cos,
          diferencia_unidades: dif, fisico_rd: fisRD, teorico_rd: teoRD, ajuste_rd: ajRD,
          familia: fam, clasificacion: clas
        };
      });

      // FASE 4 - CÁLCULO
      if (signal.aborted) return;
      updateProgress(80, "FASE 4: Verificación de cálculos y divergencias RD$...", 4);
      const final = mapped.map(item => {
        const calcDifUnidades = item.fisico - item.teorico;
        const calcAjusteRD = calcDifUnidades * item.costo_unitario;
        return {
          ...item,
          diferencia_unidades: item.diferencia_unidades !== 0 ? item.diferencia_unidades : calcDifUnidades,
          ajuste_rd: item.ajuste_rd !== 0 ? item.ajuste_rd : calcAjusteRD
        };
      }).filter(i => i.articulo.length > 2);

      // FASE 5
      if (signal.aborted) return;
      updateProgress(95, "FASE 5: Procesando índice de confiabilidad...", 5);
      
      if (final.length > 0) {
        // ✅ CAMBIO: Verificar signal antes del setState final — el proceso más crítico
        if (!signal.aborted) {
          // ✅ CAMBIO: Spread crea nueva referencia del array final — aislado del array mapped
          setState(prev => ({ ...prev, inventoryData: [...final] }));
          updateProgress(100, "FASE 6: Auditoría finalizada.", 6);
          showToast("Auditoría completada exitosamente.", "success");
        }
      } else {
        throw new Error("No se pudo extraer una tabla de inventario válida.");
      }
    } catch (err: any) {
      // ✅ CAMBIO: Solo mostrar error si no fue cancelación intencional
      if (!signal.aborted) {
        console.error(err);
        showToast(err.message || "Error en proceso contable.", "error");
      }
    } finally {
      // ✅ CAMBIO: Solo limpiar isProcessing si este proceso sigue siendo el activo
      if (!signal.aborted) {
        setState(prev => ({ ...prev, isProcessing: false }));
      }
      // ✅ CAMBIO: Destruir PDF siempre para liberar memoria, independiente de cancelación
      if (pdf) {
        try { pdf.destroy(); } catch(e) {}
      }
      // ✅ CAMBIO: Terminar worker si quedó activo por un error inesperado
      if (worker) {
        try { worker.terminate(); } catch(e) {}
      }
    }
  };

  const handleFile = (file: File) => {
    if (file.type !== 'application/pdf') {
      showToast("Por favor, selecciona un reporte de inventario en PDF.", "error");
      return;
    }
    
    if (fileInputRef.current) fileInputRef.current.value = '';
    
    processPDF(file);
  };

  const downloadExcel = () => {
    if (state.inventoryData.length === 0 || !state.file) return;
    try {
      const wb = XLSX.utils.book_new();

      const ajusteData = state.inventoryData.map(item => ({
        'Articulo': item.articulo,
        'Descripcion': item.descripcion,
        'Unidad': item.unidad,
        'Motivo': item.motivo,
        'Fisico': item.fisico,
        'Teorico': item.teorico,
        'Diferencia_Unidades': item.diferencia_unidades,
        'Costo_Unitario': item.costo_unitario,
        'Ajuste_RD$': item.ajuste_rd
      }));
      const ws1 = XLSX.utils.json_to_sheet(ajusteData);
      XLSX.utils.book_append_sheet(wb, ws1, "Ajuste_Contable");

      const totalFisico = state.inventoryData.reduce((acc, i) => acc + i.fisico, 0);
      const totalTeorico = state.inventoryData.reduce((acc, i) => acc + i.teorico, 0);
      const totalAjusteRD = state.inventoryData.reduce((acc, i) => acc + i.ajuste_rd, 0);
      const totalFaltantesRD = state.inventoryData.filter(i => i.ajuste_rd < 0).reduce((acc, i) => acc + i.ajuste_rd, 0);
      const totalSobrantesRD = state.inventoryData.filter(i => i.ajuste_rd > 0).reduce((acc, i) => acc + i.ajuste_rd, 0);

      const resumenRows = [
        ['RESUMEN DE AUDITORIA CONTABLE', ''],
        ['Total artículos', state.inventoryData.length],
        ['Total unidades físicas', totalFisico],
        ['Total unidades teóricas', totalTeorico],
        ['Diferencia total unidades', totalFisico - totalTeorico],
        ['Total ajuste RD$', totalAjusteRD],
        ['Total faltantes RD$', totalFaltantesRD],
        ['Total sobrantes RD$', totalSobrantesRD],
      ];
      const ws2 = XLSX.utils.aoa_to_sheet(resumenRows);
      XLSX.utils.book_append_sheet(wb, ws2, "Resumen_Contable");

      const sumaAbsDif = state.inventoryData.reduce((acc, i) => acc + Math.abs(i.fisico - i.teorico), 0);
      const sumaTeorico = state.inventoryData.reduce((acc, i) => acc + i.teorico, 0);
      const confiabilidad = sumaTeorico > 0 ? (1 - (sumaAbsDif / sumaTeorico)) * 100 : 100;
      
      let nivel = 'Crítica';
      if (confiabilidad >= 98) nivel = 'Excelente';
      else if (confiabilidad >= 95) nivel = 'Buena';
      else if (confiabilidad >= 90) nivel = 'Aceptable';

      const confiabilidadRows = [
        ['INDICADOR DE CONFIABILIDAD DE INVENTARIO', ''],
        ['Fórmula', 'Confiabilidad (%) = (1 - (SUMA(|Diferencia_Unidades|) / SUMA(Teorico))) * 100'],
        ['', ''],
        ['Confiabilidad general %', confiabilidad.toFixed(2) + '%'],
        ['Nivel', nivel],
      ];
      const ws3 = XLSX.utils.aoa_to_sheet(confiabilidadRows);
      XLSX.utils.book_append_sheet(wb, ws3, "Confiabilidad_Inventario");

      const fileName = `AUDITORIA_CONTABLE_${new Date().toISOString().split('T')[0]}.xlsx`;
      XLSX.writeFile(wb, fileName);
      showToast("Excel Contable generado.", "success");
    } catch (e) {
      showToast("Error al exportar Excel contable.", "error");
    }
  };

  const totalAjuste = state.inventoryData.reduce((acc, curr) => acc + curr.ajuste_rd, 0);

  return (
    <div className="min-h-screen bg-[#f8fafc] font-sans text-[#0f172a] selection:bg-indigo-100">
      <div className="max-w-6xl mx-auto py-12 px-6" key={state.processingId}>
        {/* Header Section */}
        <motion.div 
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col md:flex-row items-center justify-between mb-12 gap-6"
        >
          <div className="text-center md:text-left">
            <div className="flex items-center gap-3 mb-2 justify-center md:justify-start">
              <div className="p-2 bg-indigo-600 rounded-lg text-white">
                <Calculator className="w-6 h-6" />
              </div>
              <h1 className="text-3xl font-black tracking-tight text-slate-900 uppercase">
                Auditor <span className="text-indigo-600 underline decoration-indigo-200 decoration-4 underline-offset-4">Contable</span>
              </h1>
            </div>
            <p className="text-slate-500 font-semibold text-sm tracking-wide">
              Sistema de Procesamiento y Ajuste de Inventarios RD$
            </p>
          </div>
          <div className="flex items-center gap-4">
              <div className="bg-white border border-slate-200 px-4 py-3 rounded-xl shadow-sm text-center">
                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Estado de Auditoría</div>
                <div className="flex items-center gap-2 text-emerald-600 font-bold text-sm">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  {state.processingId > 0 ? `ID: ${new Date(state.processingId).toLocaleTimeString()}` : 'Listo'}
                </div>
              </div>
          </div>
        </motion.div>

        {/* Main Content Card */}
        <div className="bg-white rounded-[2.5rem] shadow-2xl shadow-slate-200/60 border border-slate-200/50 p-1 md:p-2 overflow-hidden">
          <div className="p-6 md:p-10">
            {!state.file && !state.isProcessing && (
              <motion.div
                layoutId="upload-zone"
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const droppedFile = e.dataTransfer.files[0];
                  if (droppedFile) handleFile(droppedFile);
                }}
                className="group cursor-pointer"
              >
                <div className="border-2 border-dashed border-slate-200 rounded-[2rem] p-20 text-center transition-all group-hover:border-indigo-500 group-hover:bg-indigo-50/20 group-hover:shadow-inner">
                  <input 
                    type="file" 
                    ref={fileInputRef}
                    className="hidden" 
                    accept=".pdf" 
                    onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
                  />
                  <div className="flex flex-col items-center">
                    <div className="w-28 h-28 bg-slate-900 text-white rounded-[1.75rem] flex items-center justify-center mb-8 group-hover:scale-110 group-hover:rotate-3 transition-transform duration-500 shadow-xl">
                      <FileText className="w-12 h-12" />
                    </div>
                    <h3 className="text-3xl font-black text-slate-900 mb-3">Cargar Inventario</h3>
                    <p className="text-slate-400 font-bold max-w-sm mx-auto text-lg">
                      Sube el reporte PDF para detección automática de artículos y costos
                    </p>
                    <div className="mt-8 flex items-center gap-4 text-xs font-black text-slate-500 uppercase tracking-[0.2em] bg-slate-100 px-6 py-3 rounded-full">
                      <span>Procesamiento Seguro</span>
                      <span className="w-1 h-1 bg-slate-400 rounded-full" />
                      <span>Formato SAP/ERP</span>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {state.isProcessing && (
              <motion.div className="py-20 flex flex-col items-center justify-center text-center space-y-8">
                <div className="relative">
                  <div className="w-24 h-24 border-4 border-slate-100 rounded-full" />
                  <div className="absolute inset-0 border-4 border-t-indigo-600 border-l-transparent border-r-transparent border-b-transparent rounded-full animate-spin" />
                  <div className="absolute inset-0 flex items-center justify-center font-black text-indigo-600">
                    {Math.round(state.progress)}%
                  </div>
                </div>
                <div className="space-y-3">
                  <h4 className="text-2xl font-black text-slate-900">{state.message}</h4>
                  <p className="text-slate-400 font-bold uppercase tracking-widest text-xs">Analizando cada fila contablemente</p>
                </div>
              </motion.div>
            )}

            {state.inventoryData.length > 0 && !state.isProcessing && (
              <div className="space-y-10 animate-in fade-in duration-500">
                {/* Stats Summary */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div className="bg-slate-900 p-6 rounded-[1.5rem] text-white">
                    <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Total Articulos</div>
                    <div className="text-3xl font-black">{state.inventoryData.length}</div>
                  </div>
                  <div className="bg-indigo-600 p-6 rounded-[1.5rem] text-white">
                    <div className="text-[10px] font-black text-indigo-200 uppercase tracking-widest mb-3">Ajuste Neto</div>
                    <div className="text-3xl font-black flex items-center gap-2">
                      <DollarSign className="w-6 h-6" />
                      {totalAjuste.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </div>
                  </div>
                  <div className="bg-emerald-500 p-6 rounded-[1.5rem] text-white">
                    <div className="text-[10px] font-black text-emerald-100 uppercase tracking-widest mb-3">Sobrantes</div>
                    <div className="text-3xl font-black flex items-center gap-2">
                       <TrendingUp className="w-6 h-6" />
                       {state.inventoryData.filter(i => (i.fisico - i.teorico) > 0).length}
                    </div>
                  </div>
                  <div className="bg-rose-500 p-6 rounded-[1.5rem] text-white">
                    <div className="text-[10px] font-black text-rose-100 uppercase tracking-widest mb-3">Faltantes</div>
                    <div className="text-3xl font-black flex items-center gap-2">
                       <TrendingDown className="w-6 h-6" />
                       {state.inventoryData.filter(i => (i.fisico - i.teorico) < 0).length}
                    </div>
                  </div>
                  <div className="bg-white border-2 border-indigo-600 p-6 rounded-[1.5rem] text-indigo-600">
                    <div className="text-[10px] font-black text-indigo-400 uppercase tracking-widest mb-3">Confiabilidad</div>
                    <div className="text-3xl font-black flex items-center gap-2">
                       <CheckCircle className="w-6 h-6" />
                       {(() => {
                         const sumaAbsDif = state.inventoryData.reduce((acc, i) => acc + Math.abs(i.fisico - i.teorico), 0);
                         const sumaTeorico = state.inventoryData.reduce((acc, i) => acc + i.teorico, 0);
                         return sumaTeorico > 0 ? ((1 - (sumaAbsDif / sumaTeorico)) * 100).toFixed(1) : '100';
                       })()}%
                    </div>
                  </div>
                </div>

                {/* Final Control Panel */}
                <div className="flex flex-col lg:flex-row gap-6">
                  <div className="flex-1 bg-white border border-slate-200 rounded-[2rem] p-8 space-y-6 shadow-sm">
                    <div className="flex items-center gap-3 border-b border-slate-100 pb-4">
                      <ClipboardList className="text-indigo-600 w-6 h-6" />
                      <h4 className="font-black text-slate-900 uppercase tracking-wider">Detalles de Auditoría</h4>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase">Responsable</label>
                        <input 
                          type="text" 
                          value={formulario.realizadoPor}
                          onChange={(e) => setFormulario({...formulario, realizadoPor: e.target.value})}
                          className="w-full bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase">Motivo</label>
                        <select 
                          value={formulario.motivo}
                          onChange={(e) => setFormulario({...formulario, motivo: e.target.value})}
                          className="w-full bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 font-bold text-slate-900 focus:outline-none"
                        >
                          <option>Cuadre de Inventario</option>
                          <option>Auditoría Sorpresiva</option>
                          <option>Ajuste de Almacén</option>
                          <option>Cierre Trimestral</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="w-full lg:w-80 flex flex-col gap-4">
                    <button 
                      onClick={downloadExcel}
                      className="flex-1 bg-indigo-600 hover:bg-slate-900 text-white rounded-[1.5rem] p-8 flex flex-col items-center justify-center gap-3 transition-all group relative overflow-hidden shadow-xl shadow-indigo-600/20"
                    >
                      <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                      <FileSpreadsheet className="w-10 h-10" />
                      <span className="font-black uppercase tracking-widest text-sm">Generar Reporte Excel</span>
                    </button>
                    <button 
                      onClick={() => setState(prev => ({ ...prev, file: null, inventoryData: [], processingId: 0, isProcessing: false, progress: 0 }))}
                      className="bg-white border border-slate-200 hover:bg-slate-50 text-slate-500 rounded-[1.25rem] py-4 flex items-center justify-center gap-2 font-bold transition-all text-sm"
                    >
                      <RefreshCw className="w-4 h-4" />
                      Nuevo Proceso
                    </button>
                  </div>
                </div>

                {/* Table Preview */}
                <div className="space-y-4">
                  <div className="flex items-center gap-2 px-2">
                    <div className="w-1.5 h-6 bg-slate-900 rounded-full" />
                    <h3 className="font-black text-slate-900 uppercase tracking-widest text-sm">Previsualización del Ajuste Contable</h3>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-xl shadow-slate-100/50">
                    <div className="overflow-x-auto max-h-[500px]">
                      <table className="w-full text-left border-collapse">
                        <thead className="sticky top-0 bg-slate-900 text-white">
                          <tr>
                            <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-left">Artículo</th>
                            <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-left">Und</th>
                            <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-left">Mot</th>
                            <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-center">Físico</th>
                            <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-center">Teórico</th>
                            <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-right">Costo UN</th>
                            <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-right">Dif RD$</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {state.inventoryData.map((item, idx) => {
                            return (
                               <tr key={idx} className="hover:bg-indigo-50/30 transition-colors group">
                                <td className="px-6 py-4">
                                  <div className="text-xs font-mono font-bold text-slate-500">{item.articulo}</div>
                                  <div className="text-sm font-bold text-slate-900 line-clamp-1">{item.descripcion}</div>
                                  <div className="text-[10px] font-black text-slate-300 uppercase line-clamp-1">{item.familia} / {item.clasificacion}</div>
                                </td>
                                <td className="px-6 py-4 text-xs font-bold text-slate-500">{item.unidad}</td>
                                <td className="px-6 py-4 text-xs font-bold text-slate-400">{item.motivo || '--'}</td>
                                <td className="px-6 py-4 text-center font-black text-slate-900 bg-slate-50/50">{item.fisico}</td>
                                <td className="px-6 py-4 text-center font-bold text-slate-400">{item.teorico}</td>
                                <td className="px-6 py-4 text-right font-mono text-xs text-slate-500">{item.costo_unitario.toLocaleString()}</td>
                                <td className={`px-6 py-4 text-right font-black text-sm ${item.ajuste_rd < 0 ? 'text-rose-600' : item.ajuste_rd > 0 ? 'text-emerald-600' : 'text-slate-900'}`}>
                                  {item.ajuste_rd.toLocaleString(undefined, { minimumFractionDigits: 2, style: 'currency', currency: 'DOP' })}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9, y: 40, x: '-50%' }}
            animate={{ opacity: 1, scale: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, scale: 0.9, y: 20, x: '-50%' }}
            className="fixed bottom-10 left-1/2 z-[100]"
          >
            <div className={`px-8 py-5 rounded-[1.5rem] shadow-2xl flex items-center gap-4 border-2 ${
              toast.type === 'error' ? 'bg-rose-950 border-rose-800 text-rose-100' : 
              toast.type === 'success' ? 'bg-slate-950 border-slate-800 text-white' : 
              'bg-indigo-950 border-indigo-900 text-indigo-100'
            }`}>
              <div className={`p-2 rounded-lg ${toast.type === 'error' ? 'bg-rose-500' : toast.type === 'success' ? 'bg-emerald-500' : 'bg-indigo-500'}`}>
                {toast.type === 'error' ? <AlertCircle className="w-5 h-5 text-white" /> : 
                 toast.type === 'success' ? <CheckCircle className="w-5 h-5 text-white" /> : 
                 <FileText className="w-5 h-5 text-white" />}
              </div>
              <span className="font-bold text-sm tracking-tight">{toast.message}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
