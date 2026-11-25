// Draws the app icons (a chalk dumbbell on plate blue) as PNGs with no image
// tools: rectangles into an RGBA buffer, encoded with zlib.
// Run: node scripts/make-icons.mjs   (writes into public/)
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BLUE = [0x1f, 0x4f, 0xd8, 255];
const CHALK = [0xee, 0xf0, 0xec, 255];

// Shapes on a 64-unit grid, same as public/icon.svg.
const shapes = [
  [10, 22, 8, 20],
  [46, 22, 8, 20],
  [18, 29, 28, 6],
];

function draw(size, scale) {
  const px = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) px.set(BLUE, i * 4);
  const unit = (size / 64) * scale;
  const offset = (size - 64 * unit) / 2;
  for (const [x, y, w, h] of shapes) {
    const x0 = Math.round(offset + x * unit), x1 = Math.round(offset + (x + w) * unit);
    const y0 = Math.round(offset + y * unit), y1 = Math.round(offset + (y + h) * unit);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) px.set(CHALK, (yy * size + xx) * 4);
  }
  return px;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, scale) {
  const px = draw(size, scale);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const out = new URL('../public/', import.meta.url);
writeFileSync(new URL('icon-192.png', out), png(192, 1));
writeFileSync(new URL('icon-512.png', out), png(512, 1));
// Maskable: keep the drawing inside the central safe zone.
writeFileSync(new URL('icon-maskable-512.png', out), png(512, 0.72));
writeFileSync(new URL('apple-touch-icon.png', out), png(180, 0.85));
console.log('icons written');
