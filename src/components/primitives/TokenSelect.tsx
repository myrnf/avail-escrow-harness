import { useState } from "react";
import type { TokenInfo, TokenSymbol } from "../../config/tokens";

interface Props {
  value: TokenInfo;
  options: TokenInfo[];
  onSelect: (symbol: TokenSymbol) => void;
  disabled?: boolean;
}

/** A TokenPill that opens a small dropdown to pick among `options`. Used for
 *  the non-USDC leg of the swap (cbBTC / ETH); USDC stays a fixed pill. */
export function TokenSelect({ value, options, onSelect, disabled }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="token-select">
      <button
        className="token-pill"
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="tk-mark" style={{ background: value.brand }} aria-hidden>
          {value.glyph}
        </span>
        {value.symbol}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          stroke="currentColor"
          fill="none"
          strokeWidth="1.4"
          aria-hidden
        >
          <path d="M2 4l3 3 3-3" />
        </svg>
      </button>

      {open ? (
        <>
          <div
            className="token-select__backdrop"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <ul className="token-select__menu" role="listbox">
            {options.map((opt) => (
              <li key={opt.symbol}>
                <button
                  type="button"
                  className="token-select__opt"
                  role="option"
                  aria-selected={opt.symbol === value.symbol}
                  onClick={() => {
                    onSelect(opt.symbol);
                    setOpen(false);
                  }}
                >
                  <span
                    className="tk-mark"
                    style={{ background: opt.brand }}
                    aria-hidden
                  >
                    {opt.glyph}
                  </span>
                  {opt.symbol}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
