// One-shot: ./icon.svg → apple-touch-icon / icon-192 / icon-512 (PNGs).
// Réutilise sharp (installé en --no-save, voir README pour réinstaller :
// `npm i --no-save --no-package-lock sharp` puis `node tools/generate-icons.mjs`).
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const svg = await readFile(path.join(ROOT, 'icon.svg'));

const sizes = [
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'icon-192.png',         size: 192 },
  { name: 'icon-512.png',         size: 512 },
];

for (const { name, size } of sizes) {
  const out = path.join(ROOT, name);
  const png = await sharp(svg, { density: 600 })
    .resize(size, size, { fit: 'cover', background: { r: 20, g: 0, b: 31, alpha: 1 } })
    .flatten({ background: { r: 20, g: 0, b: 31 } })  // garantit aucune transparence (manifest maskable)
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(out, png);
  console.log(`✓ ${name} (${size}x${size}, ${(png.length / 1024).toFixed(1)} KB)`);
}

// favicon.ico = ICO container avec un seul PNG 32x32. Format minimaliste
// mais accepté par tous les navigateurs (et IE/Edge legacy en auto-request /favicon.ico).
const ico32 = await sharp(svg, { density: 600 })
  .resize(32, 32)
  .flatten({ background: { r: 20, g: 0, b: 31 } })
  .png({ compressionLevel: 9 })
  .toBuffer();

const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry.writeUInt8(32, 0); entry.writeUInt8(32, 1);
entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(ico32.length, 8); entry.writeUInt32LE(22, 12);
const ico = Buffer.concat([dir, entry, ico32]);
await writeFile(path.join(ROOT, 'favicon.ico'), ico);
console.log(`✓ favicon.ico (32x32, ${(ico.length / 1024).toFixed(1)} KB)`);
