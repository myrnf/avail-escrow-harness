import type { Venue } from "../config/deployments";
import type { ChainToken } from "../lib/tokens";
import type { VenueFailure, VenueQuote } from "../lib/quote/types";
import { fmtAmount } from "../lib/format";

export interface VenueCardModel {
  venue: Venue;
  /** null → this venue failed or is limit-violated. */
  quote: VenueQuote | null;
  failure: VenueFailure | null;
  /** Pre-formatted supported-token limit reason, e.g. "below venue min · 10 USDC". */
  limitReason: string | null;
  isSelected: boolean;
  isBest: boolean;
  ageSec: number | null;
  isStale: boolean;
  /** Small caveat under the numbers, e.g. the KalqiX fee basis or an active
   *  routing restriction. */
  note: string | null;
  /** A quote is in flight and this venue has no result yet. Distinct from
   *  "resolved with no quote" — conflating them made every load flash "no
   *  quote" before the real answer arrived, which reads as a failure. */
  isLoading: boolean;
}

/**
 * Side-by-side venue comparison for multi-venue envs (canary). One card per
 * configured venue in stable config order — the BEST tag moves rather than
 * the cards reordering on every refresh. Cards are buttons; picking one
 * overrides the auto best-first selection.
 */
export function VenueQuoteCards({
  models,
  outInfo,
  onSelect,
  disabled,
}: {
  models: VenueCardModel[];
  outInfo: ChainToken | null;
  onSelect: (venue: Venue) => void;
  disabled: boolean;
}) {
  return (
    <div className="venues">
      {models.map((m) => {
        const dead = !m.quote && !m.isLoading;
        const cls = [
          "venue-card",
          m.isSelected ? "is-selected" : "",
          dead ? "is-dead" : "",
          m.isLoading ? "is-loading" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <button
            key={m.venue}
            type="button"
            className={cls}
            onClick={() => !dead && !m.isLoading && onSelect(m.venue)}
            disabled={disabled || dead || m.isLoading}
            aria-busy={m.isLoading || undefined}
          >
            <span className="venue-card__head">
              <span className="venue-card__name">
                {m.venue}
                {m.isBest ? <span className="venue-card__best">BEST</span> : null}
              </span>
              {m.quote && m.ageSec !== null ? (
                <span
                  className={`venue-card__age${m.isStale ? " is-stale" : ""}`}
                >
                  {m.isStale ? "STALE" : `${m.ageSec}s`}
                </span>
              ) : null}
            </span>
            {m.quote ? (
              <>
                <span className="venue-card__out num">
                  {outInfo ? fmtAmount(m.quote.amountOut, outInfo.decimals) : "—"}{" "}
                  {outInfo?.symbol}
                </span>
                <span className="venue-card__meta num">
                  min {outInfo ? fmtAmount(m.quote.amountOutMin, outInfo.decimals) : "—"} ·{" "}
                  {m.quote.priceHuman.toLocaleString(undefined, {
                    maximumFractionDigits: 2,
                  })}{" "}
                  out / in
                </span>
                {m.note ? (
                  <span className="venue-card__note">{m.note}</span>
                ) : null}
              </>
            ) : m.isLoading ? (
              <>
                <span className="venue-card__skeleton" aria-hidden />
                <span className="venue-card__meta venue-card__meta--muted">
                  fetching quote…
                </span>
                <span className="sr-only">Fetching quote</span>
              </>
            ) : (
              <span
                className="venue-card__err"
                title={
                  m.limitReason ??
                  (m.failure
                    ? [m.failure.code, m.failure.message]
                        .filter(Boolean)
                        .join(" — ")
                    : "no quote")
                }
              >
                {m.limitReason ??
                  (m.failure
                    ? m.failure.message || m.failure.code
                    : "no quote")}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
