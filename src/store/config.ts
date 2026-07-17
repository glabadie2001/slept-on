// Persistent app config (which league, which user) in localStorage.

export interface AppConfig {
  username: string;
  userId: string;
  leagueId: string;
  demo: boolean;
}

const KEY = "war-room-config-v1";

export function loadConfig(): AppConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as AppConfig;
    if (cfg.demo || (cfg.userId && cfg.leagueId)) return cfg;
    return null;
  } catch {
    return null;
  }
}

export function saveConfig(cfg: AppConfig): void {
  localStorage.setItem(KEY, JSON.stringify(cfg));
}

export function clearConfig(): void {
  localStorage.removeItem(KEY);
}
