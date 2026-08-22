import { defineConfig } from "vite";

export default defineConfig({
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: { proxy: { "/api": "http://127.0.0.1:4321", "/sync": { target: "ws://127.0.0.1:4321", ws: true } } },
});
