# xDev brand assets

The mark is an `×` and a cursor bar, a prompt waiting for input. The `×` follows the surface colour (blue `#2f62e6` on light, white on the tile, `#7aa2ff` on dark); the cursor is always the agent orange `#ff7a3d` (`--brand-agent` in `apps/desktop/src/styles/base.css`). Typeface: Be Vietnam Pro 800.

| File | Use |
| --- | --- |
| `xdev-mark.svg` | Source of the inline `BrandMark` component (`apps/desktop/src/components/BrandMark.tsx`). The `×` is `currentColor`, tinted with `--accent` in the shell header, the docs bar and the empty vault view. |
| `xdev-mark-tile.svg` | Blue tile drawn on a 16 grid for small sizes (favicon in `apps/desktop/index.html`, 16–32 px icons). |
| `xdev-lockup-light.svg`, `xdev-lockup-dark.svg` | Tile plus wordmark for light and dark surfaces (README, site, docs). Live text; bundle Be Vietnam Pro for the intended look. |
| `xdev-icon-512.png` | 512 px tile raster; the README header image and the org avatar. |
| `mobile/` | iOS (light, dark) and Android adaptive (foreground, background, monochrome) sources, with 1024 px renders. |
| `tools/gen-icons.mjs` | Renders every raster from the SVGs above and packs `icon.ico`. |

## App icons

`apps/desktop/src-tauri/icons/` is generated from a 1024 px tile (gradient `#4f84ff` → `#1f45c7`, radius 230, mark at 0.9):

1. `node docs/brand/tools/gen-icons.mjs <out>` (needs `@resvg/resvg-js`; install it in a scratch folder, not in the repo) writes `source-1024.png`, per-size tiles, `icon.ico` and `mobile/*.png`.
2. `pnpm --filter desktop tauri icon <out>/source-1024.png` writes the rest (png set, `icon.icns`). Delete the `android/` and `ios/` folders it adds.
3. Copy `tile-32.png` and `tile-64.png` over `32x32.png` and `64x64.png`, and `icon.ico` over the generated one. Sizes up to 32 px come from the 16-grid tile, so they stay crisp. `icon.ico` holds 16, 24, 32, 48, 64 and 256 px.
