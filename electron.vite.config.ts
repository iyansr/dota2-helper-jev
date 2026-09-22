import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const shared = resolve("src/shared");

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@shared": shared } },
    build: { rollupOptions: { input: { index: resolve("src/main/index.ts") } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@shared": shared } },
    build: {
      rollupOptions: {
        input: { index: resolve("src/preload/index.ts") },
        // A sandboxed preload must be self-contained CommonJS. The package is ESM, so
        // electron-vite would emit `.mjs` here and Electron would refuse to load it.
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
    resolve: { alias: { "@shared": shared } },
    build: { rollupOptions: { input: { index: resolve("src/renderer/index.html") } } },
  },
});
