/**
 * Static build of the desk for the Claude-hosted page (npm run build:static).
 * Server loaders are swapped for src/static/load.ts, which reads desk.json.
 */
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [viteReact(), tailwindcss()],
  publicDir: false,
  resolve: {
    alias: [
      { find: "@/lib/desk/load", replacement: here("./src/static/load.ts") },
      { find: /^@\//, replacement: here("./src/") },
    ],
  },
  build: {
    outDir: "dist-static",
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: here("./src/static/main.tsx"),
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "app-[name].js",
        assetFileNames: "app[extname]",
        inlineDynamicImports: true,
      },
    },
  },
});
