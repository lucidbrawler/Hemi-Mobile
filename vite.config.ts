import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
    proxy: {
      // api.merkl.xyz omits Access-Control-Allow-Origin, so the page cannot read it directly.
      "/api/merkl": {
        target: "https://api.merkl.xyz",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/merkl/, ""),
      },
    },
  },
  preview: { host: "localhost", port: 5173, strictPort: true },
  build: { target: "es2022", sourcemap: false },
});
