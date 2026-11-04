// Rasterises the xDev v9 tile into PNGs, packs icon.ico and writes the mobile icon set.
// Usage: node gen-icons.mjs <out-dir>   (needs @resvg/resvg-js resolvable, e.g. installed in a scratch folder)
// Sizes up to 32 px use the hand-drawn 16-grid tile (docs/brand/xdev-mark-tile.svg) so the × stays crisp;
// larger sizes use the gradient tile with the 1024-unit mark (docs/brand/xdev-mark.svg).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const brand = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORANGE = "#ff7a3d";
const mark = (stroke) =>
  `<path d="M316 368L580 632M580 368L316 632" stroke="${stroke}" stroke-width="112" stroke-linecap="round" fill="none"/>` +
  `<rect x="640" y="580" width="150" height="64" rx="18" fill="${ORANGE}"/>`;
const centred = (scale, body) => `<g transform="translate(512 512) scale(${scale}) translate(-525 -500)">${body}</g>`;
const BLUE = '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f84ff"/><stop offset="1" stop-color="#1f45c7"/></linearGradient>';

// The desktop tile: rounded gradient square, mark at 0.9.
export function tileSvg(size) {
  if (size <= 32) {
    return readFileSync(join(brand, "xdev-mark-tile.svg"), "utf8").replace('width="32" height="32"', `width="${size}" height="${size}"`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024"><defs>${BLUE}</defs>` +
    `<rect width="1024" height="1024" rx="230" fill="url(#g)"/>${centred(0.9, mark("#fff"))}</svg>`;
}

const render = (svg, size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
export const png = (size) => render(tileSvg(size), size);

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
  mkdirSync(join(out, "mobile"), { recursive: true });
  writeFileSync(join(out, "source-1024.svg"), tileSvg(1024));
  writeFileSync(join(out, "source-1024.png"), png(1024));
  for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) writeFileSync(join(out, `tile-${s}.png`), png(s));
  writeFileSync(join(out, "icon.ico"), ico([16, 24, 32, 48, 64, 256]));
  for (const name of ["ios-icon", "ios-icon-dark", "android-foreground", "android-background", "android-monochrome"]) {
    const svg = readFileSync(join(brand, "mobile", `${name}.svg`), "utf8");
    writeFileSync(join(out, "mobile", `${name}-1024.png`), render(svg, 1024));
  }
}
