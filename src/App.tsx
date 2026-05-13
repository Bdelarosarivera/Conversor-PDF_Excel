import { useState, useRef } from 'react';
import {
  FileText,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Calculator,
  ClipboardList,
  FileSpreadsheet,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as pdfjs from 'pdfjs-dist';
import * as XLSX from 'xlsx';
import Tesseract from 'tesseract.js';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// CONFIGURAR PDF.Je
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;

interface InventoryRow {
  articulo: string;
  descripcion: string;
  unidad: string;
  cantidadFisica: number;
  cantidadTeorica: number;
  costoUnitario: number;
  familia: string;
  clasificacion: string;
  marca: string;
  referencia: string;
  ubicacion: string;
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
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [inventoryData, setInventoryData] = useState<InventoryRow[]>([]);
  const [formulario, setFormulario] = useState<FormularioAjuste>({
    fecha: new Date().toLocaleDateString(),
    realizadoPor: 'Generado por Sistema',
    areas: 'General',
    motivo: 'Cuadre de Inventario',
    problemas: 'N/A',
    planAccion: 'Sincronización de stock',
  });
  const [state, setState] = useState<ProcessState>({
    progress: 0,
    message: '',
    isProcessing: false,
  });
  const [toast, setToast] = useState<{
    message: string;
    type: 'success' | 'error' | 'info';
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ========================================================
  // TOAST
  // ========================================================
  const showToast = (
    message: string,
    type: 'success' | 'error' | 'info' = 'info'
  ) => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(null);
    }, 4000);
  };

  // ========================================================
  // PROGRESS
  // ========================================================
  const updateProgress = (progress: number, message: string) => {
    setState((prev) => ({ ...prev, progress, message }));
  };

  // ========================================================
  // LIMPIAR NUMERO
  // ========================================================
  const cleanNumber = (val: string): number => {
    if (!val) return 0;
    const cleaned = val.replace(/[^\d.,-]/g, '').replace(/,/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  };

  // ======================================================== // ========================================================
  // OCR MEJORADO - EJECUTA SIEMPRE
  // ======================================================== // ========================================================

const runOCR = async (
  canvas: HTMLCanvasElement
): Promise<string> => {
  let worker: any;

  try {
    worker = await createWorker('spa', 1, {
      langPath: `${import.meta.env.BASE_URL}tessdata`,
      
      logger: (m) => {
        console.log(m);

        if (
          m.status ===
          'recognizing text'
        ) {
          console.log(
            `OCR Progress: ${Math.round(
              m.progress * 100
            )}%`
          );
        }
      },
    });

    const result =
      await worker.recognize(canvas);

    return result.data.text;
  } catch (error) {
    console.error(
      'OCR ERROR:',
      error
    );

    return '';
  } finally {
    if (worker) {
      await worker.terminate();
    }
  }
};



  // ======================================================== // ========================================================
  // EXTRAER TEXTO NATIVO DE PDF
  // ======================================================== // ========================================================
  const extractNativeText = async (
    pdf: any,
    totalPages: number
  ): Promise<string[][]> => {
    const extractedRows: string[][] = [];

    for (let i = 1; i <= totalPages; i++) {
      updateProgress(
        (i / totalPages) * 30,
        `Extrayendo texto nativo página ${i} de ${totalPages}`
      );

      try {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const items = textContent.items as any[];

        items.forEach((item) => {
          if (!item.str) return;
          const text = String(item.str).trim();
          if (text.length < 2) return;

          const split = text.split(/\s{2,}/);
          if (split.length >= 2) {
            extractedRows.push(split);
          } else {
            extractedRows.push([text]);
          }
        });
      } catch (error) {
        console.error(`Error extrayendo texto página ${i}:`, error);
      }
    }

    return extractedRows;
  };

  // ========================================================
  // EXTRAER TEXTO CON OCR - SIEMPRE SE EJECUTA
  // ========================================================
  const extractOCRText = async (
    pdf: any,
    totalPages: number
  ): Promise<string[][]> => {
    const extractedRows: string[][] = [];

    for (let i = 1; i <= totalPages; i++) {
      updateProgress(
        30 + (i / totalPages) * 60,
        `Procesando OCR página ${i} de ${totalPages}`
      );

      try {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2.5 }); // Mayor escala para mejor OCR
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) continue;

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        await page.render({
          canvasContext: context as any,
          viewport,
        } as any).promise;

        const text = await runOCR(canvas);
        const lines = text.split('\n');

        lines.forEach((line) => {
          const clean = line.trim();
          if (clean.length < 3) return;

          const split = clean.split(/\s{2,}/);
          if (split.length >= 2) {
            extractedRows.push(split);
          } else if (clean.length > 0) {
            extractedRows.push([clean]);
          }
        });
      } catch (error) {
        console.error(`Error en OCR página ${i}:`, error);
      }
    }

    return extractedRows;
  };

  // ========================================================
  // COMBINAR RESULTADOS DE AMBOS MÉTODOS
  // ========================================================
  const combineResults = (
    nativeText: string[][],
    ocrText: string[][]
  ): string[][] => {
    // Si hay texto nativo abundante, úsalo como base
    if (nativeText.length > 20) {
      console.log('Usando texto nativo como base principal');
      // Agregar datos de OCR que no estén duplicados
      const combined = [...nativeText];
      ocrText.forEach((ocrRow) => {
        const ocrString = ocrRow.join(' ');
        const exists = nativeText.some((nativeRow) =>
          nativeRow.join(' ').includes(ocrString.substring(0, 20))
        );
        if (!exists && ocrString.length > 5) {
          combined.push(ocrRow);
        }
      });
      return combined;
    }

    // Si el OCR tiene más datos, úsalo
    if (ocrText.length > nativeText.length) {
      console.log('Usando OCR como base principal');
      return ocrText;
    }

    // Combinar ambos
    console.log('Combinando ambas fuentes de datos');
    return [...nativeText, ...ocrText];
  };

  // ========================================================
  // PROCESAR PDF - MODO UNIVERSAL
  // ========================================================
  const processPDF = async (pdfFile: File) => {
    setState({
      isProcessing: true,
      progress: 0,
      message: 'Inicializando procesamiento universal...',
    });
    setInventoryData([]);

    try {
      const arrayBuffer = await pdfFile.arrayBuffer();
      if (arrayBuffer.byteLength === 0) {
        throw new Error('PDF vacío');
      }

      const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      const totalPages = pdf.numPages;

      updateProgress(5, `PDF cargado: ${totalPages} páginas detectadas`);

      // ===================================================
      // MÉTODO 1: EXTRAER TEXTO NATIVO
      // ===================================================
      const nativeTextRows = await extractNativeText(pdf, totalPages);
      console.log(`Texto nativo extraído: ${nativeTextRows.length} filas`);

      // ===================================================
      // MÉTODO 2: EJECUTAR OCR (SIEMPRE)
      // ===================================================
      const ocrTextRows = await extractOCRText(pdf, totalPages);
      console.log(`OCR completado: ${ocrTextRows.length} filas`);

      // ===================================================
      // COMBINAR RESULTADOS
      // ===================================================
      updateProgress(95, 'Combinando resultados...');
      const combinedRows = combineResults(nativeTextRows, ocrTextRows);

      console.log(`Total de filas combinadas: ${combinedRows.length}`);

      if (combinedRows.length === 0) {
        throw new Error(
          'No se pudo extraer ningún dato del PDF. Verifica que el archivo contenga texto o imágenes legibles.'
        );
      }

      // ===================================================
      // CREAR INVENTARIO
      // ===================================================
      const processedInventory: InventoryRow[] = combinedRows
        .map((row, index) => {
          const numbers = row
            .map((r) => cleanNumber(r))
            .filter((n) => !isNaN(n) && n > 0);

          const descripcion = row
            .filter((r) => isNaN(parseFloat(r)))
            .join(' ')
            .trim();

          // Solo procesar si hay descripción válida
          if (descripcion.length < 3) return null;

          return {
            articulo: `ITEM-${String(index + 1).padStart(4, '0')}`,
            descripcion: descripcion,
            unidad: 'UND',
            cantidadFisica: numbers[0] || 0,
            cantidadTeorica: numbers[1] || numbers[0] || 0,
            costoUnitario: numbers[2] || 0,
            familia: 'General',
            clasificacion: 'A',
            marca: 'N/A',
            referencia: `REF-${String(index + 1).padStart(4, '0')}`,
            ubicacion: 'Almacén',
          };
        })
        .filter((item): item is InventoryRow => item !== null);

      if (processedInventory.length === 0) {
        throw new Error(
          'No se pudieron interpretar los datos del PDF. Intenta con un archivo más claro.'
        );
      }

      updateProgress(100, 'Procesamiento completado');
      setInventoryData(processedInventory);
      showToast(
        `PDF procesado: ${processedInventory.length} artículos encontrados`,
        'success'
      );
    } catch (err: any) {
      console.error('Error procesando PDF:', err);
      showToast(err.message || 'Error procesando PDF', 'error');
    } finally {
      setState((prev) => ({ ...prev, isProcessing: false }));
    }
  };

  // ========================================================
  // HANDLE FILE
  // ========================================================
  const handleFile = (file: File) => {
    if (file.type !== 'application/pdf') {
      showToast('Por favor selecciona un archivo PDF válido.', 'error');
      return;
    }
    setFile(file);
    processPDF(file);
  };

  // ========================================================
  // EXPORTAR EXCEL
  // ========================================================
  const downloadExcel = () => {
    if (inventoryData.length === 0) {
      showToast('No hay datos para exportar', 'warning');
      return;
    }

    try {
      const wb = XLSX.utils.book_new();

      const ajusteData = inventoryData.map((item) => {
        const diff = item.cantidadFisica - item.cantidadTeorica;
        return {
          Articulo: item.articulo,
          Descripcion: item.descripcion,
          Unidad: item.unidad,
          Cantidad_Fisica: item.cantidadFisica,
          Cantidad_Teorica: item.cantidadTeorica,
          Diferencia_Unidades: diff,
          Costo_Unitario: item.costoUnitario,
          Ajuste_RD: diff * item.costoUnitario,
        };
      });

      const ws1 = XLSX.utils.json_to_sheet(ajusteData);
      XLSX.utils.book_append_sheet(wb, ws1, 'Ajuste_Contable');

      const detalleData = inventoryData.map((item) => ({
        Articulo: item.articulo,
        Familia: item.familia,
        Clasificacion: item.clasificacion,
        Marca: item.marca,
        Referencia: item.referencia,
        Ubicacion: item.ubicacion,
        Cantidad: item.cantidadFisica,
      }));

      const ws2 = XLSX.utils.json_to_sheet(detalleData);
      XLSX.utils.book_append_sheet(wb, ws2, 'Detalle_Inventario');

      const formRows = [
        ['CONCEPTO', 'VALOR'],
        ['Fecha de conteo', formulario.fecha],
        ['Realizado por', formulario.realizadoPor],
        ['Areas inventariadas', formulario.areas],
        ['Motivo del inventario', formulario.motivo],
        ['Problemas detectados', formulario.problemas],
        ['Plan de accion', formulario.planAccion],
      ];

      const ws3 = XLSX.utils.aoa_to_sheet(formRows);
      XLSX.utils.book_append_sheet(wb, ws3, 'Formulario_Ajuste');

      XLSX.writeFile(
        wb,
        `Inventario_Contable_${new Date().toISOString().split('T')[0]}.xlsx`
      );

      showToast('Reporte Excel generado correctamente', 'success');
    } catch (e) {
      console.error('Error exportando Excel:', e);
      showToast('Error al exportar Excel', 'error');
    }
  };

  // ========================================================
  // TOTALES
  // ========================================================
  const totalAjuste = inventoryData.reduce(
    (acc, curr) =>
      acc + (curr.cantidadFisica - curr.cantidadTeorica) * curr.costoUnitario,
    0
  );

  // ========================================================
  // UI
  // ========================================================
  return (
    <div className="min-h-screen bg-[#f8fafc] font-sans text-[#0f172a]">
      <div className="max-w-6xl mx-auto py-12 px-6">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col md:flex-row items-center justify-between mb-12 gap-6"
        >
          <div>
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 bg-indigo-600 rounded-lg text-white">
                <Calculator className="w-6 h-6" />
              </div>
              <h1 className="text-3xl font-black">Auditor Contable Pro</h1>
            </div>
            <p className="text-slate-500 font-semibold text-sm">
              Sistema de Procesamiento Universal de Inventario (OCR + Texto)
            </p>
          </div>
        </motion.div>

        <div className="bg-white rounded-3xl shadow-xl border border-slate-200 p-8">
          {!file && !state.isProcessing && (
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const droppedFile = e.dataTransfer.files[0];
                if (droppedFile) {
                  handleFile(droppedFile);
                }
              }}
              className="border-2 border-dashed border-slate-300 rounded-3xl p-20 text-center cursor-pointer hover:border-indigo-500 transition"
            >
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept=".pdf"
                onChange={(e) => {
                  if (e.target.files?.[0]) {
                    handleFile(e.target.files[0]);
                  }
                }}
              />
              <div className="flex flex-col items-center">
                <div className="w-24 h-24 bg-indigo-600 rounded-2xl flex items-center justify-center text-white mb-6">
                  <FileText className="w-12 h-12" />
                </div>
                <h3 className="text-2xl font-black mb-2">
                  Cargar Inventario PDF
                </h3>
                <p className="text-slate-500 mb-2">
                  Procesamiento Universal: Texto + OCR
                </p>
                <p className="text-slate-400 text-sm">
                  ✓ PDFs nativos | ✓ PDFs escaneados | ✓ Imágenes
                </p>
              </div>
            </div>
          )}

          {state.isProcessing && (
            <div className="py-20 flex flex-col items-center justify-center text-center space-y-6">
              <RefreshCw className="w-16 h-16 animate-spin text-indigo-600" />
              <div>
                <h4 className="text-2xl font-black">{state.message}</h4>
                <p className="text-slate-400">
                  {Math.round(state.progress)}%
                </p>
              </div>
              <div className="w-full max-w-md bg-slate-200 rounded-full h-3 overflow-hidden">
                <motion.div
                  className="bg-indigo-600 h-full"
                  initial={{ width: '0%' }}
                  animate={{ width: `${state.progress}%` }}
                  transition={{ duration: 0.3 }}
                />
              </div>
            </div>
          )}

          {inventoryData.length > 0 && !state.isProcessing && (
            <div className="space-y-8">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-slate-900 text-white p-6 rounded-2xl">
                  <div className="text-xs uppercase mb-2">Artículos</div>
                  <div className="text-3xl font-black">
                    {inventoryData.length}
                  </div>
                </div>
                <div className="bg-indigo-600 text-white p-6 rounded-2xl">
                  <div className="text-xs uppercase mb-2">Ajuste Neto</div>
                  <div className="text-2xl font-black">
                    RD$ {totalAjuste.toLocaleString()}
                  </div>
                </div>
                <div className="bg-emerald-500 text-white p-6 rounded-2xl">
                  <div className="text-xs uppercase mb-2">Sobrantes</div>
                  <div className="text-3xl font-black">
                    {
                      inventoryData.filter(
                        (i) => i.cantidadFisica - i.cantidadTeorica > 0
                      ).length
                    }
                  </div>
                </div>
                <div className="bg-rose-500 text-white p-6 rounded-2xl">
                  <div className="text-xs uppercase mb-2">Faltantes</div>
                  <div className="text-3xl font-black">
                    {
                      inventoryData.filter(
                        (i) => i.cantidadFisica - i.cantidadTeorica < 0
                      ).length
                    }
                  </div>
                </div>
              </div>

              <div className="flex flex-col lg:flex-row gap-6">
                <div className="flex-1 bg-white border border-slate-200 rounded-3xl p-8">
                  <div className="flex items-center gap-3 mb-6">
                    <ClipboardList className="text-indigo-600 w-6 h-6" />
                    <h4 className="font-black">Datos de Auditoría</h4>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                    <input
                      type="text"
                      placeholder="Realizado por"
                      value={formulario.realizadoPor}
                      onChange={(e) =>
                        setFormulario({
                          ...formulario,
                          realizadoPor: e.target.value,
                        })
                      }
                      className="border rounded-xl px-4 py-3"
                    />
                    <select
                      value={formulario.motivo}
                      onChange={(e) =>
                        setFormulario({
                          ...formulario,
                          motivo: e.target.value,
                        })
                      }
                      className="border rounded-xl px-4 py-3"
                    >
                      <option>Cuadre de Inventario</option>
                      <option>Auditoría Sorpresiva</option>
                      <option>Revisión Trimestral</option>
                      <option>Cierre de Año</option>
                    </select>
                  </div>
                </div>

                <div className="w-full lg:w-80 flex flex-col gap-4">
                  <button
                    onClick={downloadExcel}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl p-6 font-black transition flex items-center justify-center gap-2"
                  >
                    <FileSpreadsheet className="w-5 h-5" />
                    Generar Excel
                  </button>
                  <button
                    onClick={() => {
                      setFile(null);
                      setInventoryData([]);
                    }}
                    className="border border-slate-300 hover:border-indigo-500 rounded-2xl p-4 transition"
                  >
                    🔄 Nuevo Proceso
                  </button>
                </div>
              </div>

              {/* Preview de datos */}
              <div className="bg-slate-50 rounded-2xl p-6">
                <h4 className="font-black mb-4">
                  📋 Vista Previa (Primeros 5 registros)
                </h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-900 text-white">
                      <tr>
                        <th className="p-3 text-left">Artículo</th>
                        <th className="p-3 text-left">Descripción</th>
                        <th className="p-3 text-right">Cant. Física</th>
                        <th className="p-3 text-right">Cant. Teórica</th>
                        <th className="p-3 text-right">Diferencia</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inventoryData.slice(0, 5).map((item, idx) => (
                        <tr
                          key={idx}
                          className="border-b border-slate-200 hover:bg-white"
                        >
                          <td className="p-3 font-mono text-xs">
                            {item.articulo}
                          </td>
                          <td className="p-3">{item.descripcion}</td>
                          <td className="p-3 text-right">
                            {item.cantidadFisica}
                          </td>
                          <td className="p-3 text-right">
                            {item.cantidadTeorica}
                          </td>
                          <td
                            className={`p-3 text-right font-bold ${
                              item.cantidadFisica - item.cantidadTeorica > 0
                                ? 'text-emerald-600'
                                : item.cantidadFisica - item.cantidadTeorica < 0
                                ? 'text-rose-600'
                                : 'text-slate-600'
                            }`}
                          >
                            {item.cantidadFisica - item.cantidadTeorica > 0
                              ? '+'
                              : ''}
                            {item.cantidadFisica - item.cantidadTeorica}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {inventoryData.length > 5 && (
                  <p className="text-slate-400 text-sm mt-4 text-center">
                    ... y {inventoryData.length - 5} artículos más
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 30, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 20, x: '-50%' }}
            className="fixed bottom-10 left-1/2 z-50"
          >
            <div
              className={`px-6 py-4 rounded-2xl shadow-xl flex items-center gap-3 ${
                toast.type === 'error'
                  ? 'bg-red-600 text-white'
                  : toast.type === 'success'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-indigo-600 text-white'
              }`}
            >
              {toast.type === 'error' ? (
                <AlertCircle className="w-5 h-5" />
              ) : (
                <CheckCircle className="w-5 h-5" />
              )}
              <span className="font-bold">{toast.message}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
