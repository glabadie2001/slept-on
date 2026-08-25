import { log } from "../lib/log";

const DEFAULT_TIMEOUT_MS = 15_000;

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

/** fetch JSON with timeout + retry/backoff. 404 returns null (Sleeper uses it for "not found"). */
export async function fetchJson<T>(
  url: string,
  { retries = 2, timeoutMs = DEFAULT_TIMEOUT_MS }: { retries?: number; timeoutMs?: number } = {},
): Promise<T | null> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.status === 404) return null;
      if (!res.ok) throw new HttpError(res.status, url);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      // Don't retry client errors other than 429.
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        log.error("http", `HTTP ${err.status}`, url);
        throw err;
      }
      if (attempt < retries) {
        log.warn("http", `Retry ${attempt + 1}/${retries}: ${err instanceof Error ? err.message : "request failed"}`, url);
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      } else {
        log.error("http", `Failed after ${retries + 1} attempts: ${err instanceof Error ? err.message : String(err)}`, url);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
