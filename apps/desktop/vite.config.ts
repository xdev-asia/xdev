import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // `@/x` is `src/x`; tsconfig.json carries the same path for the type checker.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Tauri expects a fixed port and prints its own output.
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // WebView2 on Windows, WKWebView (Safari 13+) on the oldest supported macOS.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
  },
});
