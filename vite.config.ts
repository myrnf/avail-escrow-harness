import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Dev-time proxy for the KyberSwap aggregator — its API sends no CORS
    // headers, so the browser can't call it directly. Vercel does the same via
    // a /kyber rewrite in vercel.json for prod. (Avail's /quote, by contrast,
    // is CORS-open and called directly — no proxy.)
    proxy: {
      "/kyber": {
        target: "https://aggregator-api.kyberswap.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/kyber/, ""),
      },
    },
  },
});
