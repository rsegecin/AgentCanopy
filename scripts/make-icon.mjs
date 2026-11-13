// Dependency-free generator for media/icon.png (256x256) and media/sidebar.svg (24x24).
// The mark is an original tree canopy: three overlapping circles over a trunk.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mediaDir = join(root, 'media');

const SIZE = 256;
const SUPER = 3; // supersampling factor for anti-aliasing

/** Shapes in drawing order, in a 256x256 coordinate space. */
const background = { x: 0, y: 0, w: SIZE, h: SIZE, r: 52, color: [0x14, 0x1f, 0x1a] };
const trunk = { x: 118, y: 150, w: 20, h: 70, r: 6, color: [0x8a, 0x6a, 0x3f] };
const circles = [
  { cx: 92, cy: 128, r: 46, color: [0x2e, 0x8b, 0x57] },
  { cx: 164, cy: 128, r: 46, color: [0x3f, 0xa3, 0x68] },
  { cx: 128, cy: 84, r: 50, color: [0x5c, 0xc4, 0x7f] },
];

function inRoundedRect(px, py, s) {
  if (px < s.x || px >= s.x + s.w || py < s.y || py >= s.y + s.h) return false;
  const cx = Math.min(Math.max(px, s.x + s.r), s.x + s.w - s.r);
  const cy = Math.min(Math.max(py, s.y + s.r), s.y + s.h - s.r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= s.r ** 2;
}

function sample(px, py) {
  if (!inRoundedRect(px, py, background)) return null;
  let color = background.color;
  if (inRoundedRect(px, py, trunk)) color = trunk.color;
  for (const c of circles) {
    if ((px - c.cx) ** 2 + (py - c.cy) ** 2 <= c.r ** 2) color = c.color;
  }
  return color;
}

function render() {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    const rowStart = y * (SIZE * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < SIZE; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < SUPER; sy++) {
        for (let sx = 0; sx < SUPER; sx++) {
          const c = sample(x + (sx + 0.5) / SUPER, y + (sy + 0.5) / SUPER);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            hits++;
          }
        }
      }
      const total = SUPER * SUPER;
      const o = rowStart + 1 + x * 4;
      if (hits > 0) {
        raw[o] = Math.round(r / hits);
        raw[o + 1] = Math.round(g / hits);
        raw[o + 2] = Math.round(b / hits);
      }
      raw[o + 3] = Math.round((hits / total) * 255);
    }
  }
  return raw;
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Same mark scaled to 24x24, single colour so the host can theme it.
const sidebarSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
  <circle cx="8.6" cy="11.4" r="4.3"/>
  <circle cx="15.4" cy="11.4" r="4.3"/>
  <circle cx="12" cy="7.2" r="4.7"/>
  <rect x="11" y="13.5" width="2" height="7" rx="0.6"/>
</svg>
`;

mkdirSync(mediaDir, { recursive: true });
writeFileSync(join(mediaDir, 'icon.png'), encodePng(render()));
writeFileSync(join(mediaDir, 'sidebar.svg'), sidebarSvg);
console.log('Wrote media/icon.png and media/sidebar.svg');
