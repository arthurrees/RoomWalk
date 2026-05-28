// PDF support: render a page of an uploaded PDF to a PNG data URL, so the
// existing image-based pipeline (outline + wall tracing + detection) works
// unchanged. PDF.js is vendored locally under vendor/pdfjs/ and loaded lazily
// on the first PDF upload so it doesn't slow normal startup.

let _pdfjs = null;
async function getPdfJs() {
  if (_pdfjs) return _pdfjs;
  _pdfjs = await import('./vendor/pdfjs/pdf.mjs');
  _pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.mjs';
  return _pdfjs;
}

// True if the picked file looks like a PDF (MIME or extension).
export function isPdfFile(file) {
  return file?.type === 'application/pdf' || /\.pdf$/i.test(file?.name || '');
}

// Render one page to a PNG data URL. If the PDF has multiple pages and no
// pageNum is given, the caller is prompted to pick a page. Returns null if the
// user cancels.
//
// targetPx caps the long edge so a giant plan does not blow up canvas memory
// while still staying sharp enough to trace.
export async function renderPdfToImage(file, { pageNum, targetPx = 1800 } = {}) {
  const pdfjs = await getPdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const pageCount = pdf.numPages;
  let n = pageNum;
  if (n == null) {
    if (pageCount === 1) {
      n = 1;
    } else {
      const ans = window.prompt(
        `This PDF has ${pageCount} pages. Which page is the floor plan?`,
        '1',
      );
      if (ans === null) { pdf.destroy().catch(() => {}); return null; }
      n = Math.max(1, Math.min(pageCount, parseInt(ans, 10) || 1));
    }
  }
  const page = await pdf.getPage(n);
  // Scale so the long edge is ~targetPx; PDF.js default scale 1 is 72 DPI, way
  // too coarse for tracing.
  const v0 = page.getViewport({ scale: 1 });
  const scale = targetPx / Math.max(v0.width, v0.height);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  // White background: most PDFs draw on transparent, but the outline pass
  // expects a white background to threshold against.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const dataUrl = canvas.toDataURL('image/png');
  // Fire-and-forget destroy: awaiting it can stall follow-up calls on the
  // shared worker. GC handles the rest.
  pdf.destroy().catch(() => {});
  return { dataUrl, w: canvas.width, h: canvas.height, pageNum: n, pageCount };
}
