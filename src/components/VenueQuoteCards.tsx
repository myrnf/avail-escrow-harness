import type { Venue } from "../config/networks";
import type { TokenInfo } from "../config/tokens";
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
  pairedToken,
  onSelect,
  disabled,
}: {
  models: VenueCardModel[];
  outInfo: TokenInfo;
  pairedToken: string;
  onSelect: (venue: Venue) => void;
  disabled: boolean;
}) {
  return (
    <div className="venues">
      {models.map((m) => {
        const dead = !m.quote;
        const cls = [
          "venue-card",
          m.isSelected ? "is-selected" : "",
          dead ? "is-dead" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <button
            key={m.venue}
            type="button"
            className={cls}
            onClick={() => !dead && onSelect(m.venue)}
            disabled={disabled || dead}
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
                  {fmtAmount(m.quote.amountOut, outInfo.decimals)}{" "}
                  {outInfo.symbol}
                </span>
                <span className="venue-card__meta num">
                  min {fmtAmount(m.quote.amountOutMin, outInfo.decimals)} ·{" "}
                  {m.quote.priceHuman.toLocaleString(undefined, {
                    maximumFractionDigits: 2,
                  })}{" "}
                  USDC / {pairedToken}
                </span>
                {m.venue === "KALQIX" ? (
                  <span className="venue-card__note">
                    net of KalqiX taker fee
                  </span>
                ) : null}
              </>
            ) : (
              <span className="venue-card__err">
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
