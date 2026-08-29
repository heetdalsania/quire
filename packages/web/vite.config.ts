import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // Mermaid emits optional diagram engines up to ~690 KB. They load only after a
    // document uses that diagram type; warn if a future chunk exceeds that known ceiling.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/node_modules\/(?:@codemirror|@lezer|crelt|style-mod|w3c-keyname)\//.test(id)) return "editor";
          if (/node_modules\/(?:yjs|y-protocols|y-indexeddb|y-codemirror\.next|lib0)\//.test(id)) {
            return "collaboration";
          }
          if (id.includes("node_modules/marked/")) return "markdown";
        },
      },
    },
  },
  server: { proxy: { "/api": "http://127.0.0.1:4321", "/sync": { target: "ws://127.0.0.1:4321", ws: true } } },
});
