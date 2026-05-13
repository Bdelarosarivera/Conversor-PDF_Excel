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
  DollarSign
} from 'lucide-react';

import { motion, AnimatePresence } from 'motion/react';

import * as pdfjs from 'pdfjs-dist';
import * as XLSX from 'xlsx';

import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// CONFIGURAR PDF.JS
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

  const [formulario, setFormulario] =
    useState<FormularioAjuste>({
      fecha: new Date().toLocaleDateString(),
      realizadoPor: 'Generado por Sistema',
      areas: 'General',
      motivo: 'Cuadre de Inventario',
      problemas: 'N/A',
      planAccion: 'Sincronización de stock'
    });

  const [state, setState] =
    useState<ProcessState>({
      progress: 0,
      message: '',
      isProcessing: false
    });

  const [toast, setToast] = useState<{
    message: string;
    type: 'success' | 'error' | 'info';
  } | null>(null);

  const fileInputRef =
    useRef<HTMLInputElement>(null);

  const showToast = (
    message: string,
    type: 'success' | 'error' | 'info' = 'info'
  ) => {
    setToast({ message, type });

    setTimeout(() => {
      setToast(null);
    }, 4000);
  };

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

  const cleanNumber = (val: string): number => {
    if (!val) return 0;

    const cleaned = val
      .replace(/[^\d.,-]/g, '')
      .replace(/,/g, '');

    const num = parseFloat(cleaned);

    return isNaN(num) ? 0 : num;
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
      message:
        'Analizando estructura contable...'
    });

    setInventoryData([]);

    try {
      const arrayBuffer =
        await pdfFile.arrayBuffer();

      if (arrayBuffer.byteLength === 0) {
        throw new Error(
          'El archivo PDF está vacío.'
        );
      }

      const loadingTask = pdfjs.getDocument({
        data: arrayBuffer
      });

      const pdf = await loadingTask.promise;

      const totalPages = pdf.numPages;

      let allExtractedRows: string[][] = [];

      const ROW_TOLERANCE = 3;

      // =========================================================
      // EXTRACCIÓN NORMAL
      // =========================================================

      for (
        let i = 1;
        i <= totalPages;
        i++
      ) {
        updateProgress(
          (i / totalPages) * 100,
          `Auditando página ${i} de ${totalPages}...`
        );

        const page =
          await pdf.getPage(i);

        const textContent =
          await page.getTextContent();

        const rows: {
          y: number;
          items: any[];
        }[] = [];

        textContent.items.forEach(
          (item: any) => {
            if ('transform' in item) {
              const y =
                item.transform[5];

              let foundRow =
                rows.find(
                  r =>
                    Math.abs(r.y - y) <=
                    ROW_TOLERANCE
                );

              if (!foundRow) {
                foundRow = {
                  y,
                  items: []
                };

                rows.push(foundRow);
              }

              foundRow.items.push(item);
            }
          }
        );

        rows.sort((a, b) => b.y - a.y);

        rows.forEach(row => {
          const items = row.items.sort(
            (a, b) =>
              a.transform[4] -
              b.transform[4]
          );

          if (items.length === 0) {
            return;
          }

          const rowData: string[] = [];

          let currentStr =
            items[0].str;

          let lastX =
            items[0].transform[4] +
            (items[0].width || 0);

          for (
            let j = 1;
            j < items.length;
            j++
          ) {
            const it = items[j];

            const gap =
              it.transform[4] - lastX;

            const minGap = it.height
              ? it.height * 0.4
              : 8;

            if (gap > minGap) {
              rowData.push(
                currentStr.trim()
              );

              currentStr = it.str;
            } else {
              currentStr +=
                (currentStr.endsWith(
                  ' '
                ) ||
                it.str.startsWith(' ')
                  ? ''
                  : ' ') + it.str;
            }

            lastX =
              it.transform[4] +
              (it.width || 0);
          }

          rowData.push(currentStr.trim());

          if (
            rowData.some(
              cell => cell.length > 0
            )
          ) {
            allExtractedRows.push(
              rowData
            );
          }
        });
      }

      // =========================================================
      // VALIDAR DATOS EXTRAIDOS
      // =========================================================

      if (allExtractedRows.length === 0) {
        throw new Error(
          'No se encontró texto legible dentro del PDF.'
        );
      }

      // =========================================================
      // MAPEO INVENTARIO
      // =========================================================

      const processedInventory: InventoryRow[] =
        allExtractedRows
          .filter(row => row.length >= 2)

          .map(row => {
            const numericCells = row
              .map(c => ({
                original: c,
                val: cleanNumber(c)
              }))

              .filter(
                c =>
                  c.val !== 0 ||
                  /^[0]$/.test(
                    c.original.trim()
                  )
              );

            return {
              articulo:
                row[0] || 'N/A',

              descripcion:
                row[1] ||
                'Sin descripción',

              unidad:
                row.find(c =>
                  /^(UND|PCS|CAJA|KG|LBS|GR|UD|UNID|PAQUETE)$/i.test(
                    c.trim()
                  )
                ) || 'UND',

              cantidadFisica:
                numericCells[0]?.val ||
                0,

              cantidadTeorica:
                numericCells[1]?.val ||
                numericCells[0]?.val ||
                0,

              costoUnitario:
                numericCells[
                  numericCells.length - 1
                ]?.val || 0,

              familia: 'General',

              clasificacion: 'A',

              marca: 'Varios',

              referencia:
                row[0] || '',

              ubicacion:
                'Almacén Central'
            };
          })

          .filter(
            item =>
              !/^(Articulo|Item|Codigo|Cant|Costo|Total|Descripcion|Fecha|Pagina)$/i.test(
                item.articulo
              ) &&
              item.articulo.length > 1
          );

      if (
        processedInventory.length === 0
      ) {
        throw new Error(
          'No se pudo interpretar el inventario.'
        );
      }

      setInventoryData(
        processedInventory
      );

      showToast(
        '¡Auditoría completada satisfactoriamente!',
        'success'
      );
    } catch (err: any) {
      console.error(err);

      let msg =
        err.message ||
        'Error al procesar el inventario.';

      if (
        err.name ===
        'InvalidPDFException'
      ) {
        msg =
          'El archivo PDF está corrupto o no es válido.';
      }

      showToast(msg, 'error');
    } finally {
      setState(prev => ({
        ...prev,
        isProcessing: false
      }));
    }
  };

  // =========================================================
  // MANEJO ARCHIVO
  // =========================================================

  const handleFile = (file: File) => {
    if (
      file.type !== 'application/pdf'
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

      // SHEET 1
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

            Unidad: item.unidad,

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

      // SHEET 2
      const detalleData =
        inventoryData.map(item => ({
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
        }));

      const ws2 =
        XLSX.utils.json_to_sheet(
          detalleData
        );

      XLSX.utils.book_append_sheet(
        wb,
        ws2,
        'Detalle_Inventario'
      );

      // SHEET 3
      const formRows = [
        ['CONCEPTO', 'VALOR'],
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

      XLSX.writeFile(
        wb,
        `Inventario_Contable_${new Date()
          .toISOString()
          .split('T')[0]}.xlsx`
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

  const totalAjuste =
    inventoryData.reduce(
      (acc, curr) =>
        acc +
        (curr.cantidadFisica -
          curr.cantidadTeorica) *
          curr.costoUnitario,
      0
    );

  return (
    <div className="min-h-screen bg-[#f8fafc] font-sans text-[#0f172a]">
      <div className="max-w-6xl mx-auto py-12 px-6">
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
              Sistema de Procesamiento
              Inventario
            </p>
          </div>
        </motion.div>

        <div className="bg-white rounded-3xl shadow-xl border border-slate-200 p-8">
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
                    e.dataTransfer.files[0];

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

                  <div className="bg-emerald-500 text-white p-6 rounded-2xl">
                    <div className="text-xs uppercase mb-2">
                      Sobrantes
                    </div>

                    <div className="text-3xl font-black">
                      {
                        inventoryData.filter(
                          i =>
                            i.cantidadFisica -
                              i.cantidadTeorica >
                            0
                        ).length
                      }
                    </div>
                  </div>

                  <div className="bg-rose-500 text-white p-6 rounded-2xl">
                    <div className="text-xs uppercase mb-2">
                      Faltantes
                    </div>

                    <div className="text-3xl font-black">
                      {
                        inventoryData.filter(
                          i =>
                            i.cantidadFisica -
                              i.cantidadTeorica <
                            0
                        ).length
                      }
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
                              e.target.value
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
                              e.target.value
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
