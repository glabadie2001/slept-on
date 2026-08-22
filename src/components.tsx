import type { ReactNode } from "react";
import { useAppData } from "./AppContext";
import type { InjurySeverity } from "./lib/analysis";

const SEVERITY_BY_STATUS: Record<string, InjurySeverity> = {
  Out: "critical", IR: "critical", PUP: "critical", Sus: "critical", COV: "critical", DNR: "critical",
  Doubtful: "serious", NA: "serious",
  Questionable: "warning",
};

const SEVERITY_ICON: Record<InjurySeverity, string> = {
  critical: "⛔",
  serious: "🚑",
  warning: "⚠️",
};

export function InjuryTag({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  const sev = SEVERITY_BY_STATUS[status] ?? "warning";
  return (
    <span className={`inj ${sev}`} title={`Injury status: ${status}`}>
      {SEVERITY_ICON[sev]} {status}
    </span>
  );
}

export function PosChip({ pos }: { pos: string }) {
  return <span className={`pos-chip pos-${pos}`}>{pos.replace("SUPER_FLEX", "SF").replace("WRRB_FLEX", "W/R").replace("REC_FLEX", "W/T")}</span>;
}

export function PlayerCell({ playerId, showValue }: { playerId: string; showValue?: boolean }) {
  const { bundle, values } = useAppData();
  const p = bundle.players[playerId];
  if (!p) {
    return (
      <div className="player-cell">
        <span className="pos-chip pos-FLEX">—</span>
        <span className="player-name muted">Empty</span>
      </div>
    );
  }
  const v = values[playerId];
  return (
    <div className="player-cell">
      <PosChip pos={p.position ?? "?"} />
      <div style={{ minWidth: 0 }}>
        <div className="player-name">
          {p.full_name} <InjuryTag status={p.injury_status} />
        </div>
        <div className="player-meta">
          {p.team ?? "FA"}
          {p.age ? ` · ${p.age}y` : ""}
          {showValue && v ? ` · val ${v.value}` : ""}
          {showValue && v?.market != null ? ` · mkt ${v.market.toLocaleString()}` : ""}
        </div>
      </div>
    </div>
  );
}

export function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat-tile">
      <div className="label">{label}</div>
      <div className="value num">{value}</div>
      {sub != null && <div className="sub">{sub}</div>}
    </div>
  );
}

export function MiniBar({ pct, mine }: { pct: number; mine?: boolean }) {
  return (
    <div className={`mini-bar${mine ? " mine" : ""}`} role="img" aria-label={`${Math.round(pct)}%`}>
      <div style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
    </div>
  );
}
