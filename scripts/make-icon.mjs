import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A 256x256 multi-size ICO holding one 32-bit BGRA image. Enough for the window icon and
// for electron-builder; a bitmap keeps the repo free of binary design tooling.
const SIZE = 256;

/** @returns {[r, g, b, a]} for one pixel of the icon. */
function pixel(x, y) {
  const cx = SIZE / 2 - 0.5;
  const cy = SIZE / 2 - 0.5;
  const dx = x - cx;
  const dy = y - cy;
  const r = Math.sqrt(dx * dx + dy * dy);

  // Rounded-square field.
  const inset = 18;
  const inside = x >= inset && x < SIZE - inset && y >= inset && y < SIZE - inset;
  if (!inside) return [0, 0, 0, 0];

  // Sky-blue gradient background.
  const t = (x + y) / (SIZE * 2);
  let rr = Math.round(14 + t * 30);
  let gg = Math.round(78 + t * 70);
  let bb = Math.round(120 + t * 80);

  // A blocky "A" cut into the field, in the deep panel colour.
  const inA =
    (Math.abs(dy + 18) < 12 && Math.abs(dx) < 56) ||
    (Math.abs(dy - 4) < 12 && Math.abs(dx) < 44) ||
    (y > cy + 14 && y < cy + 44 && Math.abs(dx) < 12);
  if (inA && r < 120) {
    rr = 11;
    gg = 16;
    bb = 32;
  }

  // Soft vignette so the shape reads at small sizes.
  if (r > 104) {
    const k = Math.min(1, (r - 104) / 24);
    rr = Math.round(rr * (1 - k * 0.55));
    gg = Math.round(gg * (1 - k * 0.55));
    bb = Math.round(bb * (1 - k * 0.55));
  }

  return [rr, gg, bb, 255];
}

// BMP rows are bottom-up.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 4));
for (let y = 0; y < SIZE; y += 1) {
  const rowStart = y * (SIZE * 4 + 4);
  raw.writeUInt32LE(0, rowStart); // padding
  for (let x = 0; x < SIZE; x += 1) {
    const [r, g, b, a] = pixel(x, SIZE - 1 - y);
    const at = rowStart + 4 + x * 4;
    raw[at] = b;
    raw[at + 1] = g;
    raw[at + 2] = r;
    raw[at + 3] = a;
  }
}

const dib = Buffer.alloc(40);
dib.writeUInt32LE(40, 0); // header size
dib.writeInt32LE(SIZE, 4);
dib.writeInt32LE(SIZE * 2, 8); // height includes the XOR + AND masks
dib.writeUInt16LE(1, 12); // planes
dib.writeUInt16LE(32, 14); // bits per pixel
dib.writeUInt32LE(0, 16); // BI_RGB
dib.writeUInt32LE(raw.length, 20);
dib.writeInt32LE(2835, 24); // 72 DPI
dib.writeInt32LE(2835, 28);

// AND mask: fully opaque, one bit per pixel, rows padded to 4 bytes.
const andMask = Buffer.alloc(SIZE * (SIZE / 8));

const image = Buffer.concat([dib, raw, andMask]);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // one image

const entry = Buffer.alloc(16);
entry[0] = SIZE; // width (0 means 256)
entry[1] = SIZE; // height
entry[2] = 0; // palette size
entry[3] = 0; // reserved
entry.writeUInt16LE(1, 4); // colour planes
entry.writeUInt16LE(32, 6); // bits per pixel
entry.writeUInt32LE(image.length, 8);
entry.writeUInt32LE(header.length + entry.length, 12);

const ico = Buffer.concat([header, entry, image]);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [resolve(root, 'build/icon.ico'), resolve(root, 'resources/icon.ico')];

for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, ico);
  console.log(`[icon] wrote ${target} (${ico.length} bytes)`);
}