import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
await build({
  entryPoints: ['src/background.ts'],
  bundle: true,
  outfile: 'dist/background.js',
  sourcemap: true,
  format: 'esm',
  target: 'chrome116',
});
await build({
  entryPoints: ['src/content.ts'],
  bundle: true,
  outfile: 'dist/content.js',
  sourcemap: true,
  format: 'iife',
  target: 'chrome116',
});
await copyFile('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/pdf.worker.min.mjs');
// Generate compact raster icons without a platform-specific graphics dependency.
function crc(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type);
  const n = Buffer.alloc(4);
  n.writeUInt32BE(data.length);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([n, t, data, c]);
}
await mkdir('dist/icons', { recursive: true });
for (const size of [16, 48, 128]) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      const u = x / size,
        v = y / size;
      const mark =
        (u > 0.27 && u < 0.39 && v > 0.23 && v < 0.77) ||
        (u > 0.38 && u < 0.65 && v > 0.23 && v < 0.34) ||
        (u > 0.57 && u < 0.7 && v > 0.3 && v < 0.51) ||
        (u > 0.38 && u < 0.62 && v > 0.47 && v < 0.58) ||
        (u > 0.49 && u < 0.65 && v > 0.55 && v < 0.77);
      rows.set(mark ? [225, 250, 149, 255] : [25, 49, 43, 255], i);
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  await writeFile(
    `dist/icons/${size}.png`,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
console.log('Extension ready: dist/');
