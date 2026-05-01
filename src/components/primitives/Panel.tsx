import type { ReactNode } from "react";

interface PanelProps {
  title: string;
  status?: ReactNode;
  children: ReactNode;
}

export function Panel({ title, status, children }: PanelProps) {
  return (
    <article className="panel">
      <span className="reg-tr" />
      <span className="reg-bl" />
      <header className="panel__head">
        <h2>{title}</h2>
        {status ?? null}
      </header>
      {children}
    </article>
  );
}

interface DotProps {
  state?: "idle" | "live" | "warn" | "ok" | "err";
}
export function Dot({ state = "idle" }: DotProps) {
  const cls =
    state === "idle"
      ? "dot"
      : `dot is-${state}`;
  return <span className={cls} />;
}

interface PanelStatusProps {
  state?: "idle" | "live" | "warn" | "ok" | "err";
  children: ReactNode;
}
export function PanelStatus({ state, children }: PanelStatusProps) {
  return (
    <span className="panel__status">
      <Dot state={state} />
      {children}
    </span>
  );
}
