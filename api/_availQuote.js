import https from "node:https";

// Avail's GET /quote requires a JSON *body* on a GET request — which browsers
// (and Node's fetch/undici) refuse to send. This helper issues that request
// server-side via the raw https module, where method + body are unrestricted.
// Shared by the Vercel function (api/quote.js) and the Vite dev middleware.
// Files prefixed with "_" are not exposed as Vercel routes.

const ALLOWED_HOST = /(^|\.)availproject\.org$/;

export function fetchAvailQuote(baseUrl, payload) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(`${baseUrl.replace(/\/$/, "")}/quote`);
    } catch {
      return reject(new Error("invalid baseUrl"));
    }
    // Allowlist: only proxy to Avail hosts over https (no open SSRF proxy).
    if (u.protocol !== "https:" || !ALLOWED_HOST.test(u.hostname)) {
      return reject(new Error("baseUrl host not allowed"));
    }
    const data = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname,
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 502, body }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
