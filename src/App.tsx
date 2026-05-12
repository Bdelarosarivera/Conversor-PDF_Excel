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
import Tesseract from 'tesseract.js';

import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// PDF Worker
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
    planAccion: 'Sincronización de stock'
  });

  const [state, setState] = useState<ProcessState>({
    progress: 0,
    message: '',
    isProcessing: false
  });

  const [toast, setToast] = useState<{
    message: string;
    type: 'success' | 'error' | 'info';
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // =========================================
  // TOAST
  // =========================================

  const showToast = (
    message: string,
    type: 'success' | 'error' | 'info' = 'info'
  ) => {
    setToast({ message, type });

    setTimeout(() => {
      setToast(null);
    }, 4000);
  };

  // =========================================
  // UPDATE PROGRESS
  // =========================================

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

  // =========================================
  // OCR NORMALIZATION
  // =========================================

  const normalizeOCR = (text: string) => {
    return text
      .replace(/[|]/g, '1')
      .replace(/[O]/g, '0')
      .replace(/[l]/g, '1')
      .replace(/[S]/g, '5')
      .replace(/[B]/g, '8');
  };

  // =========================================
  // CLEAN NUMBER
  // =========================================

  const cleanNumber = (val: string): number => {

    if (!val) return 0;

    const cleaned = val
      .replace(/[RD$€£,\s]/g, '')
      .replace(/[^\d.-]/g, '');

    const num = parseFloat(cleaned);

    return isNaN(num) ? 0 : num;
  };

  // =========================================
  // OCR PDF PAGE
  // =========================================

  const extractTextWithOCR = async (page: any) => {

    const viewport = page.getViewport({ scale: 2 });

    const canvas = document.createElement('canvas');

    const context = canvas.getContext('2d');

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({
      canvasContext: context!,
      viewport
    }).promise;

    const result = await Tesseract.recognize(
      canvas,
      'spa',
      {
        logger: m => {
          console.log(m);
        }
      }
    );

    return normalizeOCR(result.data.text);
  };

  // =========================================
  // PARSE ROWS
  // =========================================

  const parseRows = (text: string) => {

    const rows: string[][] = [];

    const lines = text
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    lines.forEach(line => {

      // Split by multiple spaces
      const cols = line
        .split(/\s{2,}/)
        .map(c => c.trim())
        .filter(Boolean);

      if (cols.length >= 2) {
        rows.push(cols);
      }
    });

    return rows;
  };

  // =========================================
  // PROCESS PDF
  // =========================================

  const processPDF = async (pdfFile: File) => {

    setState({
      isProcessing: true,
      progress: 0,
      message: 'Analizando PDF...'
    });

    setInventoryData([]);

    try {

      const arrayBuffer = await pdfFile.arrayBuffer();

      if (arrayBuffer.byteLength === 0) {
        throw new Error('El archivo está vacío.');
      }

      const loadingTask = pdfjs.getDocument({
        data: arrayBuffer
      });

      const pdf = await loadingTask.promise;

      const totalPages = pdf.numPages;

      const allExtractedRows: string[][] = [];

      for (let i = 1; i <= totalPages; i++) {

        updateProgress(
          (i / totalPages) * 100,
          `Procesando página ${i} de ${totalPages}`
        );

        const page = await pdf.getPage(i);

        const textContent = await page.getTextContent();

        console.log(
          'TEXT ITEMS:',
          textContent.items.length
        );

        // =====================================
        // PDF DIGITAL
        // =====================================

        if (textContent.items.length > 0) {

          const rows: { y: number; items: any[] }[] = [];

          textContent.items.forEach((item: any) => {

            if ('transform' in item) {

              const y = item.transform[5];

              let foundRow = rows.find(
                r => Math.abs(r.y - y) <= 3
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
          });

          rows.sort((a, b) => b.y - a.y);

          rows.forEach(row => {

            const items = row.items.sort(
              (a, b) => a.transform[4] - b.transform[4]
            );

            const rowData: string[] = [];

            if (items.length === 0) return;

            let currentStr = items[0].str;

            let lastX =
              items[0].transform[4] +
              (items[0].width || 0);

            for (let j = 1; j < items.length; j++) {

              const it = items[j];

              const gap =
                it.transform[4] - lastX;

              const minGap =
                it.height
                  ? it.height * 0.4
                  : 8;

              if (gap > minGap) {

                rowData.push(currentStr.trim());

                currentStr = it.str;

              } else {

                currentStr +=
                  (currentStr.endsWith(' ') ||
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
              allExtractedRows.push(rowData);
            }
          });

        } else {

          // =====================================
          // OCR FALLBACK
          // =====================================

          showToast(
            'PDF escaneado detectado. Ejecutando OCR...',
            'info'
          );

          const ocrText =
            await extractTextWithOCR(page);

          console.log('OCR TEXT:', ocrText);

          const parsedRows =
            parseRows(ocrText);

          parsedRows.forEach(r => {
            allExtractedRows.push(r);
          });
        }
      }

      // =====================================
      // MAP INVENTORY
      // =====================================

      const processedInventory: InventoryRow[] =
        allExtractedRows

          .filter(row => row.length >= 2)

          .map(row => {

            const numericCells = row

              .map(c => ({
                original: c,
                val: cleanNumber(c)
              }))

              .filter(c =>
                c.val !== 0 ||
                /^[0]$/.test(c.original.trim())
              );

            return {

              articulo:
                row[0] || 'N/A',

              descripcion:
                row[1] || 'Sin descripción',

              unidad:
                row.find(c =>
                  /^(UND|PCS|CAJA|KG|LBS|GR|UD)$/i
                    .test(c.trim())
                ) || 'UND',

              cantidadFisica:
                numericCells[0]?.val || 0,

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

          .filter(item =>
            item.articulo &&
            item.articulo !== 'Articulo' &&
            item.articulo !== 'Código'
          );

      if (processedInventory.length === 0) {
        throw new Error(
          'No se encontraron datos válidos.'
        );
      }

      setInventoryData(processedInventory);

      showToast(
        'PDF procesado correctamente.',
        'success'
      );

    } catch (err: any) {

      console.error(err);

      showToast(
        err.message ||
        'Error al procesar PDF.',
        'error'
      );

    } finally {

      setState(prev => ({
        ...prev,
        isProcessing: false
      }));
    }
  };

  // =========================================
  // HANDLE FILE
  // =========================================

  const handleFile = (file: File) => {

    if (
      file.type !== 'application/pdf'
    ) {

      showToast(
        'Selecciona un PDF válido.',
        'error'
      );

      return;
    }

    setFile(file);

    processPDF(file);
  };

  // =========================================
  // DOWNLOAD EXCEL
  // =========================================

  const downloadExcel = () => {

    if (
      inventoryData.length === 0
    ) return;

    const wb = XLSX.utils.book_new();

    const excelData =
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

          Diferencia:
            diff,

          Costo_Unitario:
            item.costoUnitario,

          Ajuste_RD:
            diff *
            item.costoUnitario
        };
      });

    const ws =
      XLSX.utils.json_to_sheet(
        excelData
      );

    XLSX.utils.book_append_sheet(
      wb,
      ws,
      'Inventario'
    );

    XLSX.writeFile(
      wb,
      `Inventario_${Date.now()}.xlsx`
    );

    showToast(
      'Excel generado.',
      'success'
    );
  };

  // =========================================
  // TOTAL AJUSTE
  // =========================================

  const totalAjuste =
    inventoryData.reduce(
      (acc, curr) =>
        acc +
        (
          (
            curr.cantidadFisica -
            curr.cantidadTeorica
          ) *
          curr.costoUnitario
        ),
      0
    );

  return (

    <div className="min-h-screen bg-slate-100 p-10">

      <div className="max-w-6xl mx-auto">

        <div className="bg-white rounded-3xl p-10 shadow-xl">

          <div className="flex items-center gap-4 mb-10">

            <div className="bg-indigo-600 p-4 rounded-2xl text-white">
              <Calculator />
            </div>

            <div>
              <h1 className="text-4xl font-black">
                Auditor Contable OCR
              </h1>

              <p className="text-slate-500 font-bold">
                PDF → OCR → Excel
              </p>
            </div>
          </div>

          {/* Upload */}

          {!state.isProcessing &&
            inventoryData.length === 0 && (

            <div
              onClick={() =>
                fileInputRef.current?.click()
              }
              className="border-2 border-dashed border-slate-300 rounded-3xl p-20 text-center cursor-pointer hover:border-indigo-500 transition-all"
            >

              <input
                type="file"
                ref={fileInputRef}
                accept=".pdf"
                className="hidden"
                onChange={e => {

                  if (
                    e.target.files?.[0]
                  ) {

                    handleFile(
                      e.target.files[0]
                    );
                  }
                }}
              />

              <FileText className="w-20 h-20 mx-auto mb-6 text-slate-400" />

              <h2 className="text-3xl font-black mb-3">
                Subir PDF
              </h2>

              <p className="text-slate-500 font-bold">
                Compatible con PDFs digitales y escaneados
              </p>
            </div>
          )}

          {/* Processing */}

          {state.isProcessing && (

            <div className="py-20 text-center">

              <Loader2 className="w-20 h-20 animate-spin mx-auto text-indigo-600 mb-6" />

              <h2 className="text-3xl font-black mb-3">
                {state.message}
              </h2>

              <p className="text-slate-500 font-bold">
                {Math.round(state.progress)}%
              </p>
            </div>
          )}

          {/* Results */}

          {inventoryData.length > 0 &&
            !state.isProcessing && (

            <div>

              <div className="grid grid-cols-4 gap-4 mb-8">

                <div className="bg-slate-900 text-white rounded-2xl p-6">
                  <div className="text-xs uppercase font-black mb-2">
                    Artículos
                  </div>

                  <div className="text-4xl font-black">
                    {inventoryData.length}
                  </div>
                </div>

                <div className="bg-indigo-600 text-white rounded-2xl p-6">
                  <div className="text-xs uppercase font-black mb-2">
                    Ajuste
                  </div>

                  <div className="text-2xl font-black">
                    {totalAjuste.toLocaleString()}
                  </div>
                </div>

                <div className="bg-emerald-500 text-white rounded-2xl p-6">
                  <TrendingUp />
                </div>

                <div className="bg-rose-500 text-white rounded-2xl p-6">
                  <TrendingDown />
                </div>
              </div>

              {/* Buttons */}

              <div className="flex gap-4 mb-10">

                <button
                  onClick={downloadExcel}
                  className="bg-indigo-600 text-white px-8 py-4 rounded-2xl font-black"
                >
                  Generar Excel
                </button>

                <button
                  onClick={() => {

                    setFile(null);

                    setInventoryData([]);
                  }}
                  className="bg-slate-200 px-8 py-4 rounded-2xl font-black"
                >
                  Nuevo
                </button>
              </div>

              {/* Table */}

              <div className="overflow-auto border rounded-3xl">

                <table className="w-full">

                  <thead className="bg-slate-900 text-white">

                    <tr>
                      <th className="p-4">Artículo</th>
                      <th className="p-4">Descripción</th>
                      <th className="p-4">Físico</th>
                      <th className="p-4">Teórico</th>
                      <th className="p-4">Costo</th>
                    </tr>
                  </thead>

                  <tbody>

                    {inventoryData.map(
                      (item, idx) => (

                      <tr
                        key={idx}
                        className="border-b"
                      >
                        <td className="p-4">
                          {item.articulo}
                        </td>

                        <td className="p-4">
                          {item.descripcion}
                        </td>

                        <td className="p-4">
                          {item.cantidadFisica}
                        </td>

                        <td className="p-4">
                          {item.cantidadTeorica}
                        </td>

                        <td className="p-4">
                          {
                            item.costoUnitario
                          }
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Toast */}

      <AnimatePresence>

        {toast && (

          <motion.div
            initial={{
              opacity: 0,
              y: 40
            }}
            animate={{
              opacity: 1,
              y: 0
            }}
            exit={{
              opacity: 0,
              y: 40
            }}
            className="fixed bottom-10 left-1/2 -translate-x-1/2"
          >

            <div
              className={`px-8 py-5 rounded-2xl shadow-2xl flex items-center gap-4 text-white font-bold ${
                toast.type === 'error'
                  ? 'bg-rose-600'
                  : toast.type === 'success'
                  ? 'bg-emerald-600'
                  : 'bg-indigo-600'
              }`}
            >

              {toast.type === 'error'
                ? <AlertCircle />
                : toast.type === 'success'
                ? <CheckCircle />
                : <FileText />
              }

              {toast.message}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
