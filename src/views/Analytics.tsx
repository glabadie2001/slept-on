import { useMemo, useState, useSyncExternalStore } from "react";
import { clearLogs, getLogs, subscribeLogs } from "../lib/log";
import type { LogLevel } from "../lib/log";
import { StatTile } from "../components";

const LEVEL_ICON: Record<LogLevel, string> = { info: "•", warn: "⚠️", error: "⛔" };

/**
 * Hidden diagnostics page — reachable only at #analytics (or /analytics via
 * the redirect stub), never linked from the nav. Everything shown here lives
 * in this browser's localStorage; nothing is sent anywhere.
 */
export function Analytics() {
  const logs = useSyncExternalStore(subscribeLogs, getLogs);
  const [level, setLevel] = useState<"all" | LogLevel>("all");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs
      .filter((e) => (level === "all" || e.level === level))
      .filter((e) => !q || e.cat.toLowerCase().includes(q) || e.msg.toLowerCase().includes(q) || (e.detail ?? "").toLowerCase().includes(q))
      .slice()
      .reverse();
  }, [logs, level, query]);

  const errors = logs.filter((e) => e.level === "error").length;
  const warns = logs.filter((e) => e.level === "warn").length;
  const oldest = logs[0]?.ts;

  const download = () => {
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `war-room-log-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="shell">
      <div className="topbar">
        <span className="brand">🏈 War Room</span>
        <span className="league-name">Analytics · local event log</span>
        <span className="spacer" />
        <a className="linklike" href="#" onClick={(e) => { e.preventDefault(); window.location.hash = ""; }}>
          ← Back to dashboard
        </a>
      </div>

      <div className="stat-row">
        <StatTile label="Events" value={logs.length} sub="ring buffer, last 500" />
        <StatTile label="Errors" value={errors} sub={errors > 0 ? "see below" : "clean ✓"} />
        <StatTile label="Warnings" value={warns} />
        <StatTile label="Oldest entry" value={oldest ? new Date(oldest).toLocaleDateString() : "—"} sub={oldest ? new Date(oldest).toLocaleTimeString() : "empty log"} />
      </div>

      <div className="card section">
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
          <h2 style={{ margin: 0, marginRight: "auto" }}>Event log</h2>
          <select value={level} onChange={(e) => setLevel(e.target.value as typeof level)}>
            <option value="all">All levels</option>
            <option value="error">Errors</option>
            <option value="warn">Warnings</option>
            <option value="info">Info</option>
          </select>
          <input type="text" placeholder="Filter…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 180 }} />
          <button className="linklike" onClick={download}>⬇ Export JSON</button>
          <button className="linklike" onClick={() => { if (window.confirm("Clear the local event log?")) clearLogs(); }}>
            🗑 Clear
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          Stored only in this browser (localStorage) — nothing is transmitted. This page isn't linked
          from the nav; bookmark <code>#analytics</code> to come back.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Time</th><th>Level</th><th>Category</th><th>Message</th></tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={4} className="muted">No events{logs.length > 0 ? " match the filter" : " logged yet"}.</td></tr>
              )}
              {filtered.map((e, i) => (
                <tr key={`${e.ts}-${i}`}>
                  <td className="num small" style={{ whiteSpace: "nowrap" }}>{new Date(e.ts).toLocaleTimeString()}</td>
                  <td>{LEVEL_ICON[e.level]} {e.level}</td>
                  <td className="small">{e.cat}</td>
                  <td>
                    {e.msg}
                    {e.detail && (
                      <details>
                        <summary className="muted small">detail</summary>
                        <pre className="small" style={{ whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{e.detail}</pre>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
