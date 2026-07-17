import { useState } from "react";
import { sleeper } from "../api/sleeper";
import type { AppConfig } from "../store/config";
import type { SleeperLeague } from "../types";

export function Setup({
  onDone,
  initialError,
}: {
  onDone: (cfg: AppConfig) => void;
  initialError?: string | null;
}) {
  const [username, setUsername] = useState("glabadie2001");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [found, setFound] = useState<{ userId: string; username: string; leagues: SleeperLeague[] } | null>(null);

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFound(null);
    try {
      const user = await sleeper.getUser(username.trim());
      if (!user) throw new Error(`No Sleeper user named “${username.trim()}” — check the spelling.`);
      const state = await sleeper.getState();
      const season = state?.league_season ?? state?.season ?? String(new Date().getFullYear());
      const seasons = [season, String(Number(season) - 1)];
      const leagueLists = await Promise.all(
        seasons.map((s) => sleeper.getUserLeagues(user.user_id, s).catch(() => null)),
      );
      const seen = new Set<string>();
      const leagues = leagueLists
        .flatMap((l) => l ?? [])
        .filter((l) => (seen.has(l.league_id) ? false : (seen.add(l.league_id), true)));
      if (leagues.length === 0) {
        throw new Error(`Found user ${user.display_name}, but no NFL leagues for ${seasons.join("/")}.`);
      }
      if (leagues.length === 1) {
        onDone({ username: user.display_name, userId: user.user_id, leagueId: leagues[0].league_id, demo: false });
        return;
      }
      setFound({ userId: user.user_id, username: user.display_name, leagues });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setup-screen">
      <div className="setup-card">
        <div className="card">
          <h1>🏈 War Room</h1>
          <p className="muted">
            Dynasty dashboard for your Sleeper league — lineups, matchups, waivers, trades, injuries.
          </p>
          {!found && (
            <>
              <form onSubmit={lookup}>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Sleeper username"
                  aria-label="Sleeper username"
                  autoFocus
                />
                <button className="primary" disabled={busy || !username.trim()}>
                  {busy ? "Looking…" : "Connect"}
                </button>
              </form>
              <p className="muted small">
                Read-only: uses Sleeper’s public API. No password, nothing is written to your league.
              </p>
            </>
          )}
          {found && (
            <div style={{ marginTop: 14 }}>
              <h3>Pick your league</h3>
              {found.leagues.map((l) => (
                <button
                  key={l.league_id}
                  className="league-option"
                  onClick={() =>
                    onDone({ username: found.username, userId: found.userId, leagueId: l.league_id, demo: false })
                  }
                >
                  <span>{l.name}</span>
                  <span className="meta">
                    {l.season} · {l.total_rosters}-team{l.settings.type === 2 ? " · dynasty" : ""}
                  </span>
                </button>
              ))}
              <button className="ghost" onClick={() => setFound(null)}>
                ← Different user
              </button>
            </div>
          )}
          {error && <div className="error-box">{error}</div>}
          <div style={{ marginTop: 16, borderTop: "1px solid var(--grid)", paddingTop: 12 }}>
            <button
              className="ghost"
              onClick={() => onDone({ username: "demo", userId: "u1", leagueId: "demo", demo: true })}
            >
              Try the demo league instead
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
