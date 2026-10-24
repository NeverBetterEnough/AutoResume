import type { Resume } from '../types';
export const MAX_RESUME_SIZE = 8 * 1024 * 1024;
export async function parseResume(file: File): Promise<Resume> {
  if (file.size > MAX_RESUME_SIZE) throw new Error('简历文件最大 8 MB');
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (!['pdf', 'docx', 'txt', 'md'].includes(ext || ''))
    throw new Error('支持 PDF、DOCX、TXT 和 Markdown 格式；旧版 DOC 请先另存为 DOCX');
  const buffer = await file.arrayBuffer();
  let text = '';
  if (ext === 'pdf') {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      '../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).href;
    // Production worker is copied to the extension root. Development uses Vite's asset URL.
    if (typeof chrome !== 'undefined' && chrome.runtime?.id)
      pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');
    const task = pdfjs.getDocument({
      data: new Uint8Array(buffer.slice(0)),
      isEvalSupported: false,
      useSystemFonts: true,
    });
    const pdf = await task.promise;
    try {
      if (pdf.numPages > 30) throw new Error('简历最多支持 30 页');
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text +=
          content.items
            .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
            .join('') + '\n';
      }
    } finally {
      await pdf.destroy();
    }
  } else if (ext === 'docx') {
    const mammoth = await import('mammoth/mammoth.browser');
    text = (await mammoth.extractRawText({ arrayBuffer: buffer })).value;
  } else text = new TextDecoder('utf-8').decode(buffer);
  if (text.length > 100000) throw new Error('简历文字超过 10 万字符，请精简后上传');
  if (!text.trim())
    throw new Error('未提取到文字。扫描版 PDF 请先 OCR，或上传可复制文字的 PDF / DOCX');
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16384)
    binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  const mime: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
    md: 'text/markdown',
  };
  return {
    id: crypto.randomUUID(),
    name: file.name,
    mime: mime[ext!],
    base64: btoa(binary),
    text: text.trim(),
    size: file.size,
    updatedAt: new Date().toISOString(),
  };
}
