// Infra-layer peer failure — Application catches this (and Core's
// DependencyError from stubs) to skip doses/patients fail-safe.
export class PeerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerUnavailableError";
  }
}

// Distinct 404 — lets callers (e.g. orphan purge) tell "user gone" from
// "peer down"; still instanceof PeerUnavailableError for fail-safe skips.
export class PeerNotFoundError extends PeerUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "PeerNotFoundError";
  }
}

export interface JsonClientConfig {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_RETRY_DELAY_MS = 200;

// Shared service-to-service GET: Bearer service JWT, 3s timeout, 1 retry/200ms,
// any failure → DependencyError (consumed by tick/consumer, never routes).
export async function getJson<T>(
  cfg: JsonClientConfig,
  opts: {
    url: string;
    token: string;
    parse: (data: unknown) => T;
    label: string;
  },
): Promise<T> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = cfg.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let lastError: unknown = new Error(`${opts.label} unreachable`);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
    try {
      const res = await fetchImpl(opts.url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${opts.token}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const msg = `${opts.label} HTTP ${res.status}`;
        lastError = new Error(msg);
        // Permanent 4xx (except 429) — no retry budget spent.
        if (res.status === 404) {
          throw new PeerNotFoundError(msg);
        }
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new PeerUnavailableError(msg);
        }
        continue;
      }
      const data: unknown = await res.json();
      try {
        return opts.parse(data);
      } catch (e) {
        throw new PeerUnavailableError(
          `${opts.label} bad payload: ${e instanceof Error ? e.message : "parse"}`,
        );
      }
    } catch (e) {
      if (e instanceof PeerUnavailableError) throw e;
      lastError = e;
    }
  }
  throw new PeerUnavailableError(
    `${opts.label} failed: ${lastError instanceof Error ? lastError.message : "unknown"}`,
  );
}
