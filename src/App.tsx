

import { useState, useRef } from 'react';

export default function App() {

  const processPDF = async (pdfFile: File) => {

    setState({
      isProcessing: true,
      progress: 0,
      message: 'Analizando estructura contable...'
    });

  setInventoryData([]);

  let worker: any = null;

  try {
    const arrayBuffer = await pdfFile.arrayBuffer();

    if (arrayBuffer.byteLength === 0) {
      throw new Error('El archivo PDF está vacío.');
    }

    const loadingTask = pdfjs.getDocument({
      data: arrayBuffer,
      cMapUrl: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/cmaps/`,
      cMapPacked: true,
    });

    const pdf = await loadingTask.promise;
    const totalPages = pdf.numPages;

    let allExtractedRows: string[][] = [];

    const ROW_TOLERANCE = 3;

    // =========================================
    // EXTRACCIÓN NORMAL DE TEXTO
    // =========================================

    for (let i = 1; i <= totalPages; i++) {

      updateProgress(
        (i / totalPages) * 50,
        `Auditando página ${i} de ${totalPages}...`
      );

      const page = await pdf.getPage(i);

      const textContent = await page.getTextContent();

      const rows: { y: number; items: any[] }[] = [];

      textContent.items.forEach((item: any) => {

        if ('transform' in item) {

          const y = item.transform[5];

          let foundRow = rows.find(
            r => Math.abs(r.y - y) <= ROW_TOLERANCE
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

        if (items.length === 0) return;

        const rowData: string[] = [];

        let currentStr = items[0].str;

        let lastX =
          items[0].transform[4] +
          (items[0].width || 0);

        for (let j = 1; j < items.length; j++) {

          const it = items[j];

          const gap = it.transform[4] - lastX;

          const minGap = it.height
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
          rowData.some(cell => cell.length > 0)
        ) {
          allExtractedRows.push(rowData);
        }
      });
    }

    // =========================================
    // OCR SOLO SI NO SE ENCUENTRA TEXTO
    // =========================================

    if (allExtractedRows.length < 5) {

      updateProgress(
        50,
        'Buscando texto en imagen (OCR activo)...'
      );

      worker = await createWorker('spa');

      // IMPORTANTE:
      // limitar OCR para evitar congelamiento

      const maxPages = Math.min(totalPages, 3);

      for (let i = 1; i <= maxPages; i++) {

        updateProgress(
          50 + (i / maxPages) * 50,
          `Procesando imagen página ${i}...`
        );

        try {

          const page = await pdf.getPage(i);

          // IMPORTANTE:
          // bajar resolución evita congelamientos

          const viewport = page.getViewport({
            scale: 1.2
          });

          const canvas =
            document.createElement('canvas');

          const context =
            canvas.getContext('2d');

          if (!context) continue;

          canvas.height = viewport.height;
          canvas.width = viewport.width;

          await page.render({
            canvasContext: context as any,
            viewport
          } as any).promise;

          // TIMEOUT OCR

          const result = await Promise.race([
            worker.recognize(canvas),

            new Promise((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error('OCR timeout')
                  ),
                15000
              )
            )
          ]);

          const text =
            (result as any).data.text || '';

          const lines = text.split('\n');

          lines.forEach(line => {

            const rowData =
              line
                .trim()
                .split(/\s{2,}/);

            if (rowData.length >= 2) {

              allExtractedRows.push(rowData);
            }
          });

        } catch (ocrError) {

          console.error(
            'Error OCR página:',
            i,
            ocrError
          );
        }
      }
    }

    // =========================================
    // MAPEO FINAL DE DATOS
    // =========================================

    if (allExtractedRows.length === 0) {

      throw new Error(
        'No se encontró información legible.'
      );
    }

    const processedInventory: InventoryRow[] =
      allExtractedRows

        .filter(row => row.length >= 2)

        .map(row => {

          const numericCells =
            row
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
          !/^(Articulo|Item|Codigo|Cant|Costo|Total|Descripcion|Fecha|Pagina)$/i.test(
            item.articulo
          ) &&
          item.articulo.length > 1
        );

    if (processedInventory.length === 0) {

      throw new Error(
        'No se pudo interpretar el inventario.'
      );
    }

    setInventoryData(processedInventory);

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
      err.name === 'InvalidPDFException'
    ) {
      msg =
        'El archivo PDF está corrupto o no es válido.';
    }

    showToast(msg, 'error');

  } finally {

    // TERMINAR WORKER SI EXISTE

    if (worker) {
      try {
        await worker.terminate();
      } catch (e) {
        console.warn(
          'Worker terminate error',
          e
        );
      }
    }

    setState(prev => ({
      ...prev,
      isProcessing: false,
      progress: 100
    }));
  }
};
export default App;
