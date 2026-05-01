import type { TokenInfo } from "../../config/tokens";

interface Props {
  token: TokenInfo;
  onClick?: () => void;
  showCaret?: boolean;
}

export function TokenPill({ token, onClick, showCaret = false }: Props) {
  return (
    <button className="token-pill" type="button" onClick={onClick}>
      <span
        className="tk-mark"
        style={{ background: token.brand }}
        aria-hidden
      >
        {token.glyph}
      </span>
      {token.symbol}
      {showCaret ? (
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
      ) : null}
    </button>
  );
}
