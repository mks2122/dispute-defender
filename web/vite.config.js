import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:3000" } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Long-lived vendor chunks: app releases do not invalidate React or AG Grid in the browser cache.
        // A function (not an object) so React stays out of the AG Grid chunk that ag-grid-react imports.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
          if (/[\\/]node_modules[\\/]ag-grid-/.test(id)) return "aggrid";
          return undefined;
        },
      },
    },
  },
});
