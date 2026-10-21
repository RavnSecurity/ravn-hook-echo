import { type HookableStage, isHookable } from "./stages.js";

/**
 * Behaviour is encoded in the URL, because the URL is the only configuration
 * Ravn sends. Each mode exists to make one of Ravn's delivery rules visible.
 *
 *   /assess                 200 with the echo output          the happy path
 *   /assess/fail/3          500 for attempts 1–3, then 200    retried until delivered
 *   /assess/fail/always     500 forever                       packets are never lost; the hook shows failing
 *   /assess/slow/30s        waits, then 200                   Ravn's delivery timeout, then a retry
 *   /assess/status/410      that status                       how Ravn treats each status class
 *
 * The caps keep a public instance from being used to hold sockets.
 */
export const MAX_FAIL_ATTEMPTS = 20;
export const MAX_SLOW_MS = 120_000;

export type Mode =
  | { kind: "ok" }
  | { kind: "fail"; until: number }
  | { kind: "fail-always" }
  | { kind: "slow"; ms: number }
  | { kind: "status"; status: number };

export interface Route {
  /** The stage in the path, or "root" for `POST /`, which dispatches on `x-ravn-event`. */
  stage: HookableStage | "root";
  mode: Mode;
}

/** `/<stage>[/<mode>/<arg>]`, or `/[<mode>/<arg>]` for the dispatching root. Null when it is not a hook URL. */
export function parseRoute(pathname: string): Route | null {
  const segments = pathname.split("/").filter((s) => s.length > 0);
  let stage: HookableStage | "root" = "root";
  const first = segments[0];
  if (first !== undefined && isHookable(first)) {
    stage = first;
    segments.shift();
  }
  if (segments.length === 0) return { stage, mode: { kind: "ok" } };
  if (segments.length !== 2) return null;
  const [mode, arg] = segments as [string, string];
  switch (mode) {
    case "fail": {
      if (arg === "always") return { stage, mode: { kind: "fail-always" } };
      if (!/^\d{1,3}$/.test(arg)) return null;
      const n = Number(arg);
      if (n < 1) return null;
      return { stage, mode: { kind: "fail", until: Math.min(n, MAX_FAIL_ATTEMPTS) } };
    }
    case "slow": {
      const m = /^(\d{1,6})(ms|s)$/.exec(arg);
      if (!m) return null;
      const n = Number(m[1]);
      const ms = m[2] === "s" ? n * 1000 : n;
      return { stage, mode: { kind: "slow", ms: Math.min(ms, MAX_SLOW_MS) } };
    }
    case "status": {
      if (!/^\d{3}$/.test(arg)) return null;
      const status = Number(arg);
      if (status < 200 || status > 599) return null;
      return { stage, mode: { kind: "status", status } };
    }
    default:
      return null;
  }
}

export interface Decision {
  status: number;
  delayMs: number;
  /** One line for the viewer and the response body: what the mode did and why. */
  note: string;
}

/** What this attempt gets, given the mode and which attempt it is. */
export function decide(mode: Mode, attempt: number): Decision {
  switch (mode.kind) {
    case "ok":
      return { status: 200, delayMs: 0, note: "ok" };
    case "fail":
      return attempt <= mode.until
        ? {
            status: 500,
            delayMs: 0,
            note: `failing on request: attempt ${attempt} of ${mode.until} that fail`,
          }
        : {
            status: 200,
            delayMs: 0,
            note: `ok: attempt ${attempt}, after ${mode.until} that failed`,
          };
    case "fail-always":
      return { status: 500, delayMs: 0, note: `failing on request: always (attempt ${attempt})` };
    case "slow":
      return { status: 200, delayMs: mode.ms, note: `ok after waiting ${mode.ms}ms on request` };
    case "status":
      return { status: mode.status, delayMs: 0, note: `status ${mode.status} on request` };
  }
}

export function describeMode(mode: Mode): string {
  switch (mode.kind) {
    case "ok":
      return "ok";
    case "fail":
      return `fail/${mode.until}`;
    case "fail-always":
      return "fail/always";
    case "slow":
      return `slow/${mode.ms}ms`;
    case "status":
      return `status/${mode.status}`;
  }
}
