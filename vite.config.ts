import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fetchAvailQuote } from "./api/_availQuote.js";

// Dev-server equivalent of the Vercel /api/quote function — there's no
// serverless runtime under `vite dev`, so handle POST /api/quote here.
// Minimal structural types for the dev middleware (avoids a @types/node dep).
type ReqLike = { method?: string; on(ev: string, cb: (chunk: unknown) => void): void };
type ResLike = {
  statusCode: number;
  setHeader(k: string, v: string): void;
  end(body?: string): void;
};

function quoteProxyPlugin(): Plugin {
  return {
    name: "avail-quote-proxy",
    configureServer(server) {
      server.middlewares.use("/api/quote", (rawReq, rawRes) => {
        const req = rawReq as unknown as ReqLike;
        const res = rawRes as unknown as ResLike;
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("POST only");
          return;
        }
        let raw = "";
        req.on("data", (c) => (raw += String(c)));
        req.on("end", async () => {
          try {
            const { baseUrl, token_in, token_out, amount_in, slippage_bps } =
              JSON.parse(raw || "{}");
            const payload: Record<string, unknown> = {
              token_in,
              token_out,
              amount_in,
            };
            if (slippage_bps != null) payload.slippage_bps = slippage_bps;
            const { status, body } = await fetchAvailQuote(baseUrl, payload);
            res.statusCode = status;
            res.setHeader("Content-Type", "application/json");
            res.end(body);
          } catch (e) {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: String((e as Error)?.message || e) }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), quoteProxyPlugin()],

  server: {
    port: 5173,
    // Dev-time proxy for the KyberSwap aggregator — its API sends no CORS
    // headers, so the browser can't call it directly. Vercel does the same via
    // a /kyber rewrite in vercel.json for prod.
    proxy: {
      "/kyber": {
        target: "https://aggregator-api.kyberswap.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/kyber/, ""),
      },
    },
  },
});
