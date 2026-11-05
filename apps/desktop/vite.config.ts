/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { configDefaults } from "vitest/config";
import { defaultClientConditions, defaultServerConditions, defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // `@/x` is `src/x`; tsconfig.json carries the same path for the type checker.
  // `xdev-source` makes `@xdev-asia/ui` resolve to packages/xdev-ui/src (no dist build needed);
  // vite 6+ replaces the default condition list, so the defaults are spread back in.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    conditions: ["xdev-source", ...defaultClientConditions],
    dedupe: ["react", "react-dom"],
  },
  ssr: { resolve: { conditions: ["xdev-source", ...defaultServerConditions] } },
  // The library source lives outside node_modules; inlining lets vi.mock("react") reach it.
  // The browser specs in e2e/ belong to Playwright, not vitest.
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"],
    server: { deps: { inline: ["@xdev-asia/ui"] } },
  },
  // Tauri expects a fixed port and prints its own output.
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // WebView2 on Windows, WKWebView (Safari 13+) on the oldest supported macOS.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
  },
});
