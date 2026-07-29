/**
 * Verification for source-restricted KYBERSWAP quotes.
 *
 * `venue_options[].option.included_sources` is a request-side ask: the server
 * forwards it to Kyber, and nothing in the response states which restriction
 * was applied. But a Kyber `routeSummary` names the pool behind every hop, so
 * the answer is already in the payload — read the route back and confirm it
 * only used the sources we asked for.
 *
 * This matters because the failure is silent: a request whose options were
 * dropped returns a perfectly valid best-route quote, which the UI would
 * otherwise label as restricted and the user would trade on. Checking the
 * route means a restricted quote is either genuinely restricted or visibly
 * failed — never quietly wrong.
 */

/** Every distinct pool/dex id used across a routeSummary's hops. */
export function routeExchanges(
  venueDetail: { routeSummary?: unknown } | null | undefined
): string[] {
  const rs = venueDetail?.routeSummary as
    | { route?: Array<Array<{ exchange?: unknown }>> }
    | undefined;
  if (!Array.isArray(rs?.route)) return [];
  const out = new Set<string>();
  for (const hop of rs.route) {
    if (!Array.isArray(hop)) continue;
    for (const step of hop) {
      if (typeof step?.exchange === "string") out.add(step.exchange);
    }
  }
  return [...out];
}

/** Pool ids in the route that fall outside `allowed`. Empty → restriction
 *  held (also empty when the route can't be read, which is not evidence of
 *  a violation). */
export function disallowedExchanges(
  venueDetail: { routeSummary?: unknown } | null | undefined,
  allowed: string[]
): string[] {
  const permitted = new Set(allowed);
  return routeExchanges(venueDetail).filter((e) => !permitted.has(e));
}
