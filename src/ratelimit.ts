import type { IncomingMessage } from "node:http";

/**
 * A fixed-window counter per key: at most `limit` hits per `windowMs`. In
 * memory, for one process. The key count is capped, so a stream of new keys
 * (every request from a new address) cannot grow it without bound: past the
 * cap, the oldest windows are dropped, which only ever lets a request through.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(opts: { limit: number; windowMs?: number; maxKeys?: number }) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs ?? 60_000;
    this.maxKeys = opts.maxKeys ?? 50_000;
  }

  /** Count one hit. `ok: false` with the seconds until the window resets when over the limit. */
  take(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterS: number } {
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.delete(key);
      w = { start: now, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > this.maxKeys) this.sweep(now);
    }
    w.count += 1;
    if (w.count <= this.limit) return { ok: true };
    return {
      ok: false,
      retryAfterS: Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000)),
    };
  }

  /** Drop expired windows, then the oldest while still over the cap. */
  sweep(now = Date.now()): void {
    for (const [k, w] of this.windows) {
      if (now - w.start >= this.windowMs) this.windows.delete(k);
    }
    while (this.windows.size > this.maxKeys) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }
}

/**
 * The address a request came from. With `trustedHops` proxies in front (each
 * appending to `x-forwarded-for`), the client is the entry that many places
 * from the end. Anything before it was written by the client and is not used.
 * Zero hops, or a header too short to hold that many: the socket's address.
 */
export function clientIp(req: IncomingMessage, trustedHops: number): string {
  const socket = req.socket.remoteAddress ?? "unknown";
  if (trustedHops <= 0) return socket;
  const raw = req.headers["x-forwarded-for"];
  const header = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  const hops = header
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return hops[hops.length - trustedHops] ?? socket;
}
