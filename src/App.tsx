import { useState, useRef } from 'react';
import {
  FileText,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Calculator,
  ClipboardList
} from 'lucide-react';

import { motion, AnimatePresence } from 'motion/react';

import * as pdfjs from 'pdfjs-dist';
import * as XLSX from 'xlsx';

import Tesseract from 'tesseract.js';

// =========================================================
// PDF.JS WORKER
// =========================================================

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

// =========================================================
// TYPES
// =========================================================

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

// =========================================================
// APP
// =========================================================

export default function App() {
  const [file, setFile] =
    useState<File | null>(null);

  const [inventoryData, setInventoryData] =
    useState<InventoryRow[]>([]);

  const [formulario, setFormulario] =
    useState<FormularioAjuste>({
      fecha: new Date().toLocaleDateString(),
      realizadoPor:
        'Generado por Sistema',
      areas: 'General',
      motivo: 'Cuadre de Inventario',
      problemas: 'N/A',
      planAccion:
        'Sincronización de stock'
    });

  const [state, setState] =
    useState<ProcessState>({
      progress: 0,
      message: '',
      isProcessing: false
    });

  const [toast, setToast] =
    useState<{
      message: string;
      type:
        | 'success'
        | 'error'
        | 'info';
    } | null>(null);

  const fileInputRef =
    useRef<HTMLInputElement>(null);

  // =========================================================
  // TOAST
  // =========================================================

  const showToast = (
    message: string,
    type:
      | 'success'
      | 'error'
      | 'info' = 'info'
  ) => {
    setToast({
      message,
      type
    });

    setTimeout(() => {
      setToast(null);
    }, 4000);
  };

  // =========================================================
  // PROGRESS
  // =========================================================

  const updateProgress = (
    progress: number,
    message: string
  ) => {
    setState(prev => ({
      ...prev,
      progress,
      message
    }));
  };

  // =========================================================
  // LIMPIAR NUMEROS
  // =========================================================

  const cleanNumber = (
    val: string
  ): number => {
    if (!val) return 0;

    let cleaned = val
      .replace(/[^\d.,-]/g, '')
      .trim();

    if (!cleaned) return 0;

    const lastComma =
      cleaned.lastIndexOf(',');

    const lastDot =
      cleaned.lastIndexOf('.');

    // FORMATO EUROPEO
    // 1.234,56
    if (lastComma > lastDot) {
      cleaned = cleaned
        .replace(/\./g, '')
        .replace(',', '.');
    }

    // FORMATO USA
    // 1,234.56
    else {
      cleaned =
        cleaned.replace(/,/g, '');
    }

    const num =
      parseFloat(cleaned);

    return isNaN(num) ? 0 : num;
  };

  // =========================================================
  // OCR
  // =========================================================

  const runOCR = async (
    canvas: HTMLCanvasElement
  ) => {
    const result =
      await Tesseract.recognize(
        canvas,
        'spa',
        {
          logger: m => {
            console.log(m);
          },

          // FIX ERROR 404
          langPath:
            'https://tessdata.projectnaptha.com/4.0.0'
        }
      );

    return result.data.text;
  };

  // =========================================================
  // PROCESAR PDF
  // =========================================================

  const processPDF = async (
    pdfFile: File
  ) => {
    setState({
      isProcessing: true,
      progress: 0,
      message: 'Procesando PDF...'
    });

    setInventoryData([]);

    try {
      const arrayBuffer =
        await pdfFile.arrayBuffer();

      if (
        arrayBuffer.byteLength === 0
      ) {
        throw new Error(
          'PDF vacío'
        );
      }

      const loadingTask =
        pdfjs.getDocument({
          data: arrayBuffer
        });

      const pdf =
        await loadingTask.promise;

      const totalPages =
        pdf.numPages;

      let extractedRows: string[][] =
        [];

      // =====================================================
      // EXTRAER TEXTO NORMAL
      // =====================================================

      for (
        let i = 1;
        i <= totalPages;
        i++
      ) {
        updateProgress(
          (i / totalPages) * 40,
          `Leyendo página ${i} de ${totalPages}`
        );

        const page =
          await pdf.getPage(i);

        const textContent =
          await page.getTextContent();

        const items =
          textContent.items as any[];

        items.forEach(item => {
          if (!item.str) return;

          const text = String(
            item.str
          ).trim();

          if (text.length < 2)
            return;

          const split =
            text.split(/\s{2,}/);

          if (split.length >= 2) {
            extractedRows.push(
              split
            );
          } else {
            extractedRows.push([
              text,
              text
            ]);
          }
        });
      }

      // =====================================================
      // OCR SI NO HAY TEXTO
      // =====================================================

      if (
        extractedRows.length < 10
      ) {
        updateProgress(
          50,
          'PDF escaneado detectado. Ejecutando OCR...'
        );

        for (
          let i = 1;
          i <= totalPages;
          i++
        ) {
          updateProgress(
            50 +
              (i / totalPages) *
                40,
            `OCR página ${i} de ${totalPages}`
          );

          const page =
            await pdf.getPage(i);

          const viewport =
            page.getViewport({
              scale: 2
            });

          const canvas =
            document.createElement(
              'canvas'
            );

          const context =
            canvas.getContext('2d');

          if (!context) continue;

          canvas.width =
            viewport.width;

          canvas.height =
            viewport.height;

          await page.render({
            canvasContext:
              context as any,
            viewport
          } as any).promise;

          // EVITA FREEZE UI
          await new Promise(
            resolve =>
              setTimeout(
                resolve,
                50
              )
          );

          const text =
            await runOCR(canvas);

          const lines =
            text.split('\n');

          lines.forEach(line => {
            const clean =
              line.trim();

            if (
              clean.length < 3
            )
              return;

            const split =
              clean.split(
                /\s{2,}/
              );

            if (
              split.length >= 2
            ) {
              extractedRows.push(
                split
              );
            } else {
              extractedRows.push([
                clean,
                clean
              ]);
            }
          });
        }
      }

      // =====================================================
      // VALIDAR
      // =====================================================

      if (
        extractedRows.length === 0
      ) {
        throw new Error(
          'No se encontró texto legible dentro del PDF.'
        );
      }

      // =====================================================
      // PROCESAR INVENTARIO
      // =====================================================

      const processedInventory: InventoryRow[] =
        extractedRows
          .map((row, index) => {
            const numbers = row
              .map(r =>
                cleanNumber(r)
              )
              .filter(
                n =>
                  !isNaN(n)
              );

            return {
              articulo: `ITEM-${
                index + 1
              }`,

              descripcion:
                row.join(' '),

              unidad: 'UND',

              cantidadFisica:
                numbers[0] || 0,

              cantidadTeorica:
                numbers[1] || 0,

              costoUnitario:
                numbers[2] || 0,

              familia:
                'General',

              clasificacion:
                'A',

              marca: 'N/A',

              referencia: `REF-${
                index + 1
              }`,

              ubicacion:
                'Almacén'
            };
          })

          .filter(
            item =>
              item.descripcion
                .trim()
                .length > 3
          );

      if (
        processedInventory.length ===
        0
      ) {
        throw new Error(
          'No se pudo interpretar el PDF.'
        );
      }

      setInventoryData(
        processedInventory
      );

      showToast(
        'PDF procesado correctamente',
        'success'
      );
    } catch (err: any) {
      console.error(err);

      showToast(
        err.message ||
          'Error procesando PDF',
        'error'
      );
    } finally {
      setState(prev => ({
        ...prev,
        isProcessing: false
      }));
    }
  };

  // =========================================================
  // HANDLE FILE
  // =========================================================

  const handleFile = (
    file: File
  ) => {
    if (
      file.type !==
      'application/pdf'
    ) {
      showToast(
        'Por favor selecciona un PDF.',
        'error'
      );

      return;
    }

    setFile(file);

    processPDF(file);
  };

  // =========================================================
  // EXPORTAR EXCEL
  // =========================================================

  const downloadExcel = () => {
    if (
      inventoryData.length === 0
    ) {
      return;
    }

    try {
      const wb =
        XLSX.utils.book_new();

      // ============================================
      // HOJA AJUSTE
      // ============================================

      const ajusteData =
        inventoryData.map(item => {
          const diff =
            item.cantidadFisica -
            item.cantidadTeorica;

          return {
            Articulo:
              item.articulo,

            Descripcion:
              item.descripcion,

            Unidad:
              item.unidad,

            Cantidad_Fisica:
              item.cantidadFisica,

            Cantidad_Teorica:
              item.cantidadTeorica,

            Diferencia_Unidades:
              diff,

            Costo_Unitario:
              item.costoUnitario,

            Ajuste_RD:
              diff *
              item.costoUnitario
          };
        });

      const ws1 =
        XLSX.utils.json_to_sheet(
          ajusteData
        );

      XLSX.utils.book_append_sheet(
        wb,
        ws1,
        'Ajuste_Contable'
      );

      // ============================================
      // HOJA DETALLE
      // ============================================

      const detalleData =
        inventoryData.map(
          item => ({
            Articulo:
              item.articulo,

            Familia:
              item.familia,

            Clasificacion:
              item.clasificacion,

            Marca:
              item.marca,

            Referencia:
              item.referencia,

            Ubicacion:
              item.ubicacion,

            Cantidad:
              item.cantidadFisica
          })
        );

      const ws2 =
        XLSX.utils.json_to_sheet(
          detalleData
        );

      XLSX.utils.book_append_sheet(
        wb,
        ws2,
        'Detalle_Inventario'
      );

      // ============================================
      // FORMULARIO
      // ============================================

      const formRows = [
        [
          'CONCEPTO',
          'VALOR'
        ],

        [
          'Fecha de conteo',
          formulario.fecha
        ],

        [
          'Realizado por',
          formulario.realizadoPor
        ],

        [
          'Areas inventariadas',
          formulario.areas
        ],

        [
          'Motivo del inventario',
          formulario.motivo
        ],

        [
          'Problemas detectados',
          formulario.problemas
        ],

        [
          'Plan de accion',
          formulario.planAccion
        ]
      ];

      const ws3 =
        XLSX.utils.aoa_to_sheet(
          formRows
        );

      XLSX.utils.book_append_sheet(
        wb,
        ws3,
        'Formulario_Ajuste'
      );

      // ============================================
      // EXPORTAR
      // ============================================

      XLSX.writeFile(
        wb,
        `Inventario_Contable_${
          new Date()
            .toISOString()
            .split('T')[0]
        }.xlsx`
      );

      showToast(
        'Reporte generado correctamente.',
        'success'
      );
    } catch (e) {
      console.error(e);

      showToast(
        'Error al exportar Excel.',
        'error'
      );
    }
  };

  // =========================================================
  // TOTALES
  // =========================================================

  const totalAjuste =
    inventoryData.reduce(
      (acc, curr) =>
        acc +
        (curr.cantidadFisica -
          curr.cantidadTeorica) *
          curr.costoUnitario,
      0
    );

  // =========================================================
  // UI
  // =========================================================

  return (
    <div className="min-h-screen bg-[#f8fafc] font-sans text-[#0f172a]">
      <div className="max-w-6xl mx-auto py-12 px-6">

        {/* HEADER */}

        <motion.div
          initial={{
            opacity: 0,
            y: -20
          }}
          animate={{
            opacity: 1,
            y: 0
          }}
          className="flex flex-col md:flex-row items-center justify-between mb-12 gap-6"
        >
          <div>
            <div className="flex items-center gap-3 mb-2">

              <div className="p-2 bg-indigo-600 rounded-lg text-white">
                <Calculator className="w-6 h-6" />
              </div>

              <h1 className="text-3xl font-black">
                Auditor Contable
              </h1>
            </div>

            <p className="text-slate-500 font-semibold text-sm">
              Sistema de Procesamiento Inventario
            </p>
          </div>
        </motion.div>

        {/* CARD */}

        <div className="bg-white rounded-3xl shadow-xl border border-slate-200 p-8">

          {/* UPLOAD */}

          {!file &&
            !state.isProcessing && (
              <div
                onClick={() =>
                  fileInputRef.current?.click()
                }

                onDragOver={e =>
                  e.preventDefault()
                }

                onDrop={e => {
                  e.preventDefault();

                  const droppedFile =
                    e.dataTransfer
                      .files[0];

                  if (droppedFile) {
                    handleFile(
                      droppedFile
                    );
                  }
                }}

                className="border-2 border-dashed border-slate-300 rounded-3xl p-20 text-center cursor-pointer hover:border-indigo-500 transition"
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  className="hidden"
                  accept=".pdf"

                  onChange={e => {
                    if (
                      e.target.files?.[0]
                    ) {
                      handleFile(
                        e.target
                          .files[0]
                      );
                    }
                  }}
                />

                <div className="flex flex-col items-center">

                  <div className="w-24 h-24 bg-indigo-600 rounded-2xl flex items-center justify-center text-white mb-6">
                    <FileText className="w-12 h-12" />
                  </div>

                  <h3 className="text-2xl font-black mb-2">
                    Cargar Inventario
                  </h3>

                  <p className="text-slate-500">
                    Selecciona un PDF
                  </p>
                </div>
              </div>
            )}

          {/* PROCESANDO */}

          {state.isProcessing && (
            <div className="py-20 flex flex-col items-center justify-center text-center space-y-6">

              <RefreshCw className="w-16 h-16 animate-spin text-indigo-600" />

              <div>
                <h4 className="text-2xl font-black">
                  {state.message}
                </h4>

                <p className="text-slate-400">
                  {Math.round(
                    state.progress
                  )}
                  %
                </p>
              </div>
            </div>
          )}

          {/* RESULTADOS */}

          {inventoryData.length > 0 &&
            !state.isProcessing && (
              <div className="space-y-8">

                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">

                  <div className="bg-slate-900 text-white p-6 rounded-2xl">

                    <div className="text-xs uppercase mb-2">
                      Artículos
                    </div>

                    <div className="text-3xl font-black">
                      {
                        inventoryData.length
                      }
                    </div>
                  </div>

                  <div className="bg-indigo-600 text-white p-6 rounded-2xl">

                    <div className="text-xs uppercase mb-2">
                      Ajuste Neto
                    </div>

                    <div className="text-2xl font-black">
                      {totalAjuste.toLocaleString()}
                    </div>
                  </div>
                </div>

                <div className="flex flex-col lg:flex-row gap-6">

                  <div className="flex-1 bg-white border border-slate-200 rounded-3xl p-8">

                    <div className="flex items-center gap-3 mb-6">

                      <ClipboardList className="text-indigo-600 w-6 h-6" />

                      <h4 className="font-black">
                        Auditoría
                      </h4>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">

                      <input
                        type="text"

                        value={
                          formulario.realizadoPor
                        }

                        onChange={e =>
                          setFormulario({
                            ...formulario,
                            realizadoPor:
                              e.target
                                .value
                          })
                        }

                        className="border rounded-xl px-4 py-3"
                      />

                      <select
                        value={
                          formulario.motivo
                        }

                        onChange={e =>
                          setFormulario({
                            ...formulario,
                            motivo:
                              e.target
                                .value
                          })
                        }

                        className="border rounded-xl px-4 py-3"
                      >
                        <option>
                          Cuadre de Inventario
                        </option>

                        <option>
                          Auditoría Sorpresiva
                        </option>
                      </select>
                    </div>
                  </div>

                  <div className="w-full lg:w-80 flex flex-col gap-4">

                    <button
                      onClick={
                        downloadExcel
                      }

                      className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl p-6 font-black transition"
                    >
                      Generar Excel
                    </button>

                    <button
                      onClick={() => {
                        setFile(null);

                        setInventoryData(
                          []
                        );
                      }}

                      className="border rounded-2xl p-4"
                    >
                      Nuevo Proceso
                    </button>
                  </div>
                </div>
              </div>
            )}
        </div>
      </div>

      {/* TOAST */}

      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{
              opacity: 0,
              y: 30,
              x: '-50%'
            }}

            animate={{
              opacity: 1,
              y: 0,
              x: '-50%'
            }}

            exit={{
              opacity: 0,
              y: 20,
              x: '-50%'
            }}

            className="fixed bottom-10 left-1/2 z-50"
          >
            <div
              className={`px-6 py-4 rounded-2xl shadow-xl flex items-center gap-3 ${
                toast.type ===
                'error'
                  ? 'bg-red-600 text-white'
                  : toast.type ===
                    'success'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-indigo-600 text-white'
              }`}
            >
              {toast.type ===
              'error' ? (
                <AlertCircle className="w-5 h-5" />
              ) : (
                <CheckCircle className="w-5 h-5" />
              )}

              <span className="font-bold">
                {toast.message}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
