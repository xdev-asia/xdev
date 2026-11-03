// Rasterises the flat xDev tile into pixel-aligned PNGs and packs icon.ico.
// Usage: node gen-icons.mjs <out-dir>   (needs @resvg/resvg-js resolvable, e.g. installed in a scratch folder)
// The mark's coordinates are all multiples of 3, so a scale of k/3 keeps every edge on a whole pixel.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const BLUE = "#2f62e6";
const MARK = '<path d="M0 3H6L15 12L6 21H0L9 12Z"/><path d="M12 18H21V21H12Z"/>';
// size -> mark scale (in thirds). The mark spans 21x18 units; 2/3 -> 14x12 etc.
const THIRDS = { 16: 2, 24: 2, 32: 3, 48: 4, 64: 6, 128: 9, 256: 18 };

export function tileSvg(size) {
  const t = THIRDS[size] ?? Math.round((size * 0.66) / 21) * 3; // large sizes: ~66% mark, whole-pixel scale
  const s = t / 3;
  const w = 21 * s, h = 18 * s;
  // The mark's vertical extent is y 3..21 -> centre 12; horizontal 0..21 -> centre 10.5.
  const x = Math.round((size - w) / 2);
  const y = Math.round(size / 2 - 12 * s);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" rx="${size / 4}" fill="${BLUE}"/>` +
    `<g transform="translate(${x} ${y}) scale(${s})" fill="#fff">${MARK}</g></svg>`;
}

export const png = (size) => new Resvg(tileSvg(size), { fitTo: { mode: "width", value: size } }).render().asPng();

function ico(sizes) {
  const images = sizes.map((s) => png(s));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head[e] = s >= 256 ? 0 : s;
    head[e + 1] = s >= 256 ? 0 : s;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(images[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}

const out = process.argv[2];
if (out) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "source-1024.svg"), tileSvg(1024));
  writeFileSync(join(out, "source-1024.png"), png(1024));
  for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) writeFileSync(join(out, `tile-${s}.png`), png(s));
  writeFileSync(join(out, "icon.ico"), ico([16, 24, 32, 48, 64, 256]));
}
