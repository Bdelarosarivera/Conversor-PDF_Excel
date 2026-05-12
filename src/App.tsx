// Initialize PDF.js with fallback
const getWorkerSrc = () => {
  try {
    return pdfjsWorker || `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`;
  } catch {
    return `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.mjs`;
  }
};
pdfjs.GlobalWorkerOptions.workerSrc = getWorkerSrc();

interface InventoryRow {
  articulo: string;
  descripcion: string;
  unidad: string;
  cantidadFisica: number;
  cantidadTeorica: number;
  costoUnitario: number;
  // Extended fields
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
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const updateProgress = (progress: number, message: string) => {
    setState(prev => ({ ...prev, progress, message }));
  };

  const cleanNumber = (val: string): number => {
    if (!val) return 0;
    // Remove currency symbols, commas, and spaces
    const cleaned = val.replace(/[RD$€£\s,]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  };

  const processPDF = async (pdfFile: File) => {
    setState({ isProcessing: true, progress: 0, message: 'Analizando estructura contable...' });
    setInventoryData([]);

    try {
      const arrayBuffer = await pdfFile.arrayBuffer();
      if (arrayBuffer.byteLength === 0) throw new Error("El archivo PDF está vacío.");

      const loadingTask = pdfjs.getDocument({ 
        data: arrayBuffer,
        useWorkerFetch: true,
      });

      const pdf = await loadingTask.promise;
      const totalPages = pdf.numPages;
      const allExtractedRows: string[][] = [];
      
      const ROW_TOLERANCE = 3;

      for (let i = 1; i <= totalPages; i++) {
        updateProgress((i / totalPages) * 100, `Auditando página ${i} de ${totalPages}...`);
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        
        const rows: { y: number; items: any[] }[] = [];
        textContent.items.forEach((item: any) => {
          if ('transform' in item) {
            const y = item.transform[5];
            let foundRow = rows.find(r => Math.abs(r.y - y) <= ROW_TOLERANCE);
            if (!foundRow) {
              foundRow = { y: y, items: [] };
              rows.push(foundRow);
            }
            foundRow.items.push(item);
          }
        });

        rows.sort((a, b) => b.y - a.y);
        rows.forEach(row => {
          const items = row.items.sort((a, b) => a.transform[4] - b.transform[4]);
          const rowData: string[] = [];
          if (items.length === 0) return;

          let currentStr = items[0].str;
          let lastX = items[0].transform[4] + (items[0].width || 0);

          for (let j = 1; j < items.length; j++) {
            const it = items[j];
            const gap = it.transform[4] - lastX;
            const minGap = it.height ? it.height * 0.4 : 8;
            
            if (gap > minGap) { 
              rowData.push(currentStr.trim());
              currentStr = it.str;
            } else {
              currentStr += (currentStr.endsWith(' ') || it.str.startsWith(' ') ? '' : ' ') + it.str;
            }
            lastX = it.transform[4] + (it.width || 0);
          }
          rowData.push(currentStr.trim());
          if (rowData.some(cell => cell.length > 0)) allExtractedRows.push(rowData);
        });
      }

      // Business Logic: Identify Header and Map Columns
      if (allExtractedRows.length > 0) {
        // More robust mapping: try to find columns by content type
        const processedInventory: InventoryRow[] = allExtractedRows
          .filter(row => row.length >= 2) // Be more permissive with row length
          .map(row => {
            // Find cells that look like numbers (Quantity, Cost)
            const numericCells = row.map(c => ({ original: c, val: cleanNumber(c) }))
                                   .filter(c => c.val !== 0 || /^[0]$/.test(c.original.trim()));

            return {
              articulo: row[0] || 'N/A',
              descripcion: row[1] || 'Sin descripción',
              unidad: row.find(c => /^(UND|PCS|CAJA|KG|LBS|GR|UD)$/i.test(c.trim())) || 'UND',
              cantidadFisica: numericCells[0]?.val || 0,
              cantidadTeorica: numericCells[1]?.val || numericCells[0]?.val || 0,
              costoUnitario: numericCells[numericCells.length - 1]?.val || 0,
              familia: 'General',
              clasificacion: 'A',
              marca: 'Varios',
              referencia: row[0] || '',
              ubicacion: 'Almacén Central'
            };
          })
          // Filter out rows that are likely headers or empty
          .filter(item => item.articulo !== 'Articulo' && item.articulo !== 'Código');

        if (processedInventory.length > 0) {
          setInventoryData(processedInventory);
          showToast("¡Auditoría completada con éxito!", "success");
        } else {
          throw new Error("Se detectó texto, pero no se pudo identificar una tabla de inventario válida.");
        }
      } else {
        throw new Error("No se detectó texto extraíble. Si esto es un escaneo o foto, el sistema no podrá leerlo sin OCR.");
      }
    } catch (err: any) {
      console.error(err);
      let msg = err.message || "Error al procesar el inventario.";
      if (err.name === 'InvalidPDFException') msg = "El archivo PDF está corrupto o no es válido.";
      showToast(msg, "error");
    } finally {
      setState(prev => ({ ...prev, isProcessing: false }));
    }
  };

  const handleFile = (file: File) => {
    if (file.type !== 'application/pdf') {
      showToast("Por favor, selecciona un reporte de inventario en PDF.", "error");
      return;
    }
    setFile(file);
    processPDF(file);
  };

  const downloadExcel = () => {
    if (inventoryData.length === 0 || !file) return;
    try {
      const wb = XLSX.utils.book_new();

      // Sheet 1: Ajuste_Contable
      const ajusteData = inventoryData.map(item => {
        const diff = item.cantidadFisica - item.cantidadTeorica;
        return {
          'Articulo': item.articulo,
          'Descripcion': item.descripcion,
          'Unidad': item.unidad,
          'Cantidad_Fisica': item.cantidadFisica,
          'Cantidad_Teorica': item.cantidadTeorica,
          'Diferencia_Unidades': diff,
          'Costo_Unitario': item.costoUnitario,
          'Ajuste_RD$': diff * item.costoUnitario
        };
      });
      const ws1 = XLSX.utils.json_to_sheet(ajusteData);
      XLSX.utils.book_append_sheet(wb, ws1, "Ajuste_Contable");

      // Sheet 2: Detalle_Inventario
      const detalleData = inventoryData.map(item => ({
        'Articulo': item.articulo,
        'Familia': item.familia,
        'Clasificacion': item.clasificacion,
        'Marca': item.marca,
        'Referencia': item.referencia,
        'Ubicacion': item.ubicacion,
        'Cantidad_por_Ubicacion': item.cantidadFisica,
        'Total_Articulo': item.cantidadFisica,
        'Diferencia': item.cantidadFisica - item.cantidadTeorica
      }));
      const ws2 = XLSX.utils.json_to_sheet(detalleData);
      XLSX.utils.book_append_sheet(wb, ws2, "Detalle_Inventario");

      // Sheet 3: Formulario_Ajuste
      const formRows = [
        ['CONCEPTO', 'VALOR'],
        ['Fecha de conteo', formulario.fecha],
        ['Realizado por', formulario.realizadoPor],
        ['Areas inventariadas', formulario.areas],
        ['Motivo del inventario', formulario.motivo],
        ['Problemas detectados', formulario.problemas],
        ['Plan de accion', formulario.planAccion],
        [],
        ['RESUMEN DE AUDITORIA', ''],
        ['Items Procesados', inventoryData.length],
        ['Total Ajuste Positivo (Sobrantes)', inventoryData.filter(i => (i.cantidadFisica - i.cantidadTeorica) > 0).length],
        ['Total Ajuste Negativo (Faltantes)', inventoryData.filter(i => (i.cantidadFisica - i.cantidadTeorica) < 0).length],
      ];
      const ws3 = XLSX.utils.aoa_to_sheet(formRows);
      XLSX.utils.book_append_sheet(wb, ws3, "Formulario_Ajuste");

      const fileName = `Inventario_Contable_${new Date().toISOString().split('T')[0]}.xlsx`;
      XLSX.writeFile(wb, fileName);
      showToast("Reporte contable generado.", "success");
    } catch (e) {
      showToast("Error al exportar reporte.", "error");
    }
  };

  const totalAjuste = inventoryData.reduce((acc, curr) => acc + (curr.cantidadFisica - curr.cantidadTeorica) * curr.costoUnitario, 0);

  return (
    <div className="min-h-screen bg-[#f8fafc] font-sans text-[#0f172a] selection:bg-indigo-100">
      <div className="max-w-6xl mx-auto py-12 px-6">
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
                Motor IA Activo
              </div>
            </div>
          </div>
        </motion.div>

        {/* Main Content Card */}
        <div className="bg-white rounded-[2.5rem] shadow-2xl shadow-slate-200/60 border border-slate-200/50 p-1 md:p-2 overflow-hidden">
          <div className="p-6 md:p-10">
            {!file && !state.isProcessing && (
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

            {inventoryData.length > 0 && !state.isProcessing && (
              <div className="space-y-10 animate-in fade-in duration-500">
                {/* Stats Summary */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div className="bg-slate-900 p-6 rounded-[1.5rem] text-white">
                    <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Total Articulos</div>
                    <div className="text-3xl font-black">{inventoryData.length}</div>
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
                       {inventoryData.filter(i => (i.cantidadFisica - i.cantidadTeorica) > 0).length}
                    </div>
                  </div>
                  <div className="bg-rose-500 p-6 rounded-[1.5rem] text-white">
                    <div className="text-[10px] font-black text-rose-100 uppercase tracking-widest mb-3">Faltantes</div>
                    <div className="text-3xl font-black flex items-center gap-2">
                       <TrendingDown className="w-6 h-6" />
                       {inventoryData.filter(i => (i.cantidadFisica - i.cantidadTeorica) < 0).length}
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
                      onClick={() => { setFile(null); setInventoryData([]); }}
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
                            <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest">Articulo</th>
                            <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest">Descripción</th>
                            <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-center">Fisico</th>
                            <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-center">Teorico</th>
                            <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-center">Dif. Und.</th>
                            <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-right">Ajuste RD$</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {inventoryData.map((item, idx) => {
                            const diff = item.cantidadFisica - item.cantidadTeorica;
                            const adjustment = diff * item.costoUnitario;
                            return (
                              <tr key={idx} className="hover:bg-indigo-50/30 transition-colors group">
                                <td className="px-6 py-4 font-mono text-xs font-bold text-slate-500">{item.articulo}</td>
                                <td className="px-6 py-4">
                                  <div className="text-sm font-bold text-slate-900">{item.descripcion}</div>
                                  <div className="text-[10px] font-black text-slate-300 uppercase">{item.familia}</div>
                                </td>
                                <td className="px-6 py-4 text-center font-black text-slate-900">{item.cantidadFisica}</td>
                                <td className="px-6 py-4 text-center font-bold text-slate-400">{item.cantidadTeorica}</td>
                                <td className="px-6 py-4 text-center">
                                  <span className={`inline-flex items-center gap-1 font-black text-sm ${diff < 0 ? 'text-rose-500' : diff > 0 ? 'text-emerald-500' : 'text-slate-400'}`}>
                                    {diff > 0 && '+'}
                                    {diff}
                                  </span>
                                </td>
                                <td className={`px-6 py-4 text-right font-black text-sm ${adjustment < 0 ? 'text-rose-600' : adjustment > 0 ? 'text-emerald-600' : 'text-slate-900'}`}>
                                  {adjustment.toLocaleString(undefined, { minimumFractionDigits: 2, style: 'currency', currency: 'DOP' })}
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
