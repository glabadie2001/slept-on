// In-app diagnostics log: a persisted ring buffer of app events (API calls,
// load milestones, errors, user actions) surfaced on the hidden /analytics
// page. Fully client-side — nothing ever leaves the browser.

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  ts: number; // epoch ms
  level: LogLevel;
  cat: string; // short category: "http", "league", "market", "ui", "crash"
  msg: string;
  detail?: string;
}

const KEY = "war-room-log-v1";
const CAP = 500;

function load(): LogEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(-CAP) : [];
  } catch {
    return [];
  }
}

let entries: LogEntry[] = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // storage full/unavailable — keep the in-memory buffer
  }
}

export function logEvent(level: LogLevel, cat: string, msg: string, detail?: string): void {
  entries = [...entries, { ts: Date.now(), level, cat, msg, detail }].slice(-CAP);
  persist();
  for (const fn of listeners) fn();
}

export const log = {
  info: (cat: string, msg: string, detail?: string) => logEvent("info", cat, msg, detail),
  warn: (cat: string, msg: string, detail?: string) => logEvent("warn", cat, msg, detail),
  error: (cat: string, msg: string, detail?: string) => logEvent("error", cat, msg, detail),
};

/** Snapshot for useSyncExternalStore — reference changes on every write. */
export function getLogs(): readonly LogEntry[] {
  return entries;
}

export function clearLogs(): void {
  entries = [];
  persist();
  for (const fn of listeners) fn();
}

export function subscribeLogs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let installed = false;

/** Route uncaught errors and promise rejections into the log (idempotent). */
export function installGlobalErrorCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) => {
    logEvent("error", "crash", e.message || "Uncaught error", e.error instanceof Error ? e.error.stack : undefined);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    logEvent(
      "error",
      "crash",
      r instanceof Error ? r.message : `Unhandled rejection: ${String(r)}`,
      r instanceof Error ? r.stack : undefined,
    );
  });
}
