import { fetchAvailQuote } from "./_availQuote.js";

// POST /api/quote { baseUrl, token_in, token_out, amount_in, slippage_bps? }
// Proxies to Avail's GET /quote (which needs a GET-with-body the browser can't
// send). Returns Avail's response verbatim (status + JSON).
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const { baseUrl, token_in, token_out, amount_in, slippage_bps } =
    req.body || {};
  if (!baseUrl || !token_in || !token_out || !amount_in) {
    res.status(400).json({ error: "missing required fields" });
    return;
  }
  try {
    const payload = { token_in, token_out, amount_in };
    if (slippage_bps != null) payload.slippage_bps = slippage_bps;
    const { status, body } = await fetchAvailQuote(baseUrl, payload);
    res.status(status).setHeader("Content-Type", "application/json").send(body);
  } catch (e) {
    res.status(502).json({ error: String(e?.message || e) });
  }
}
