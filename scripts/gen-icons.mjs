// PWA icon generator (doc 01 §App shell & PWA) — zero dependencies.
// Renders the brand mark (the compass in Retenix teal on graphite-950) to
// PNG at every required size and writes valid files by hand: raw RGBA
// scanlines → zlib → PNG chunks. Deterministic; outputs are committed.
//
//   node scripts/gen-icons.mjs
//
// Outputs:
//   apps/web/public/icons/icon-192.png            manifest icon
//   apps/web/public/icons/icon-512.png            manifest icon
//   apps/web/public/icons/icon-maskable-512.png   purpose: maskable
//   apps/web/app/apple-icon.png                   apple-touch-icon (Next file convention)
//   apps/web/app/icon.png                         favicon (Next file convention)

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// graphite-950 and teal-500 (dark) as sRGB — same conversion as scripts/contrast.ts
const BG = [11, 14, 17];
const TEAL = [79, 205, 205];

// --- PNG plumbing -----------------------------------------------------------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // scanlines with filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- mark geometry (matches components/avatars/BrokerAvatar.tsx, 40-unit box)

const RING_C = [20, 20];
const RING_R = 9;
const RING_HALF = 0.9; // 1.8-unit stroke — slightly heavier than UI for icon legibility
const NEEDLE = [
  [25.6, 14.4],
  [21.5, 21.5],
  [14.4, 25.6],
  [18.5, 18.5],
];

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function inMark(x, y) {
  const d = Math.hypot(x - RING_C[0], y - RING_C[1]);
  if (Math.abs(d - RING_R) <= RING_HALF) return true;
  return inPolygon(x, y, NEEDLE);
}

function render(size) {
  const scale = size / 40;
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 3; // 3×3 supersampling
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / scale;
          const y = (py + (sy + 0.5) / SS) / scale;
          if (inMark(x, y)) hits++;
        }
      }
      const a = hits / (SS * SS);
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) {
        rgba[i + c] = Math.round(BG[c] + (TEAL[c] - BG[c]) * a);
      }
      rgba[i + 3] = 255;
    }
  }
  return png(size, rgba);
}

const outputs = [
  ["apps/web/public/icons/icon-192.png", 192],
  ["apps/web/public/icons/icon-512.png", 512],
  // the mark spans ~45% of the canvas — comfortably inside the 80% maskable
  // safe zone, so the maskable asset is the same full-bleed render
  ["apps/web/public/icons/icon-maskable-512.png", 512],
  ["apps/web/app/apple-icon.png", 180],
  ["apps/web/app/icon.png", 64],
];

for (const [rel, size] of outputs) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, render(size));
  console.log(`wrote ${rel} (${size}×${size})`);
}
