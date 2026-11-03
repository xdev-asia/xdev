# xDev brand assets

The mark is flat: a chevron and a cursor bar on a 24 grid, whole-unit coordinates (every one is a multiple of 3, so it lands on whole pixels at 16, 24, 32, 48 and 64 px).

| File | Use |
| --- | --- |
| `xdev-mark.svg` | Source of the inline `BrandMark` component (`apps/desktop/src/components/BrandMark.tsx`); `currentColor`, tinted with `--accent` in the shell header, the docs bar and the empty vault view. |
| `xdev-mark-tile.svg` | Blue tile with the white mark. Favicon in `apps/desktop/index.html`. |
| `xdev-lockup-light.svg`, `xdev-lockup-dark.svg` | Mark plus wordmark for light and dark surfaces (README, site, docs). Live text; bundle Be Vietnam Pro for the intended look. |
| `xdev-icon-512.png` | 512 px tile raster; the README header image. |
| `tools/gen-icons.mjs` | Draws the tile per size (pixel-aligned) and packs `icon.ico`. |

## App icons

`apps/desktop/src-tauri/icons/` is generated from a 1024 px tile (`#2f62e6`, radius 256, mark 672 px wide):

1. `node docs/brand/tools/gen-icons.mjs <out>` (needs `@resvg/resvg-js`; install it in a scratch folder, not in the repo) writes `source-1024.png`, per-size tiles and `icon.ico`.
2. `pnpm --filter desktop tauri icon <out>/source-1024.png` writes the rest (png set, `icon.icns`). Delete the `android/` and `ios/` folders it adds.
3. Copy `tile-32.png` and `tile-64.png` over `32x32.png` and `64x64.png`, and `icon.ico` over the generated one. Downscaling the 1024 image is soft at small sizes; the per-size tiles are crisp. `icon.ico` holds 16, 24, 32, 48, 64 and 256 px.
