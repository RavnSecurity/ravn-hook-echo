import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOOKABLE, type HookableStage, isHookable } from "./stages.js";

export interface Config {
  port: number;
  host: string;
  /**
   * The signing secret Ravn shows once. Null boots the hook unconfigured: it
   * serves `/healthz` and the viewer, and refuses every delivery with 503.
   */
  secret: string | null;
  showValues: boolean;
  retentionHours: number;
  publicBaseUrl: string;
  viewToken: string;
  /** VIEW_TOKEN was set. Then the token is never printed: logs may be shipped elsewhere. */
  viewTokenFromEnv: boolean;
  /** Fetch the schema from its `$id` at start. Off keeps the vendored copy (tests, air-gapped runs). */
  fetchSchema: boolean;
  /** Where Ravn is: `https://apps.ravnsecurity.io`, or a local stack. */
  ravnUrl: string;
  /** The service account's one-time unwrap token. Never printed. */
  unwrapToken: string | null;
  /** An access token to use as is, never renewed. Never printed. */
  accessTokenOnly: string | null;
  /** Where the current refresh token is kept, mode 600. */
  stateFile: string;
  /** The stages this hook answers when it has a service account. */
  answerStages: HookableStage[];
}

export const DEFAULT_RAVN_URL = "https://apps.ravnsecurity.io";
export const DEFAULT_STATE_FILE = join(homedir(), ".ravn-hook-echo", "state.json");

export class ConfigError extends Error {}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.trim().toLowerCase());
}

export const USAGE = `ravn-hook-echo — a reference Ravn Hook for every triage stage

  ravn-hook-echo [--port N] [--host H] [--show-values] [--no-fetch-schema]

Environment
  RAVN_HOOK_SECRET  the signing secret Ravn showed when the hook was created.
                    Unset, deliveries are refused with 503 until it is.
  PORT              listen port (default 8080)
  HOST              bind address (default 0.0.0.0)
  VIEW_TOKEN        the viewer's bearer token; never printed. Unset, one is
                    generated and printed once
  RETENTION_HOURS   how long deliveries stay in memory (default 24)
  PUBLIC_BASE_URL   the URL Ravn reaches this hook on, for the printed addresses

As a service account: answer every stage, and read over MCP
  RAVN_UNWRAP_TOKEN       the one-time unwrap token from the service account in Ravn
  RAVN_ACCESS_TOKEN_ONLY  instead, an access token to use as is, never renewed
  RAVN_STATE_FILE         where the refresh token is kept (default ~/.ravn-hook-echo/state.json)
  ANSWER_STAGES           the stages to answer, comma-separated, or none (default: all six)
  RAVN_URL                where Ravn is (default https://apps.ravnsecurity.io)

Flags
  --show-values     the viewer shows packet values, not only their shape.
                    Refused unless --host is 127.0.0.1 or ::1.
  --no-fetch-schema use the vendored schema; do not fetch the published one.
  --help`;

export function parseConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Config | "help" {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) throw new ConfigError(`unexpected argument: ${a}`);
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    if ((name === "port" || name === "host") && next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }
  if (flags.has("help")) return "help";
  for (const k of flags.keys()) {
    if (!["port", "host", "show-values", "no-fetch-schema"].includes(k)) {
      throw new ConfigError(`unknown flag: --${k}`);
    }
  }

  const secret = env.RAVN_HOOK_SECRET || null;

  const port = integer(String(flags.get("port") ?? env.PORT ?? "8080"), "PORT", 0, 65535);
  const host = String(flags.get("host") ?? env.HOST ?? "0.0.0.0");
  const showValues = flags.get("show-values") === true;
  if (showValues && !isLoopback(host)) {
    throw new ConfigError(
      `--show-values is refused on ${host}: it is for your own laptop. Bind to 127.0.0.1 or ::1.`,
    );
  }
  const retentionHours = integer(env.RETENTION_HOURS ?? "24", "RETENTION_HOURS", 0, 24 * 365);
  const viewTokenFromEnv = Boolean(env.VIEW_TOKEN?.trim());
  const viewToken = env.VIEW_TOKEN?.trim() || randomBytes(16).toString("hex");
  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const publicBaseUrl = (env.PUBLIC_BASE_URL?.trim() || `http://${displayHost}:${port}`).replace(
    /\/+$/,
    "",
  );
  const unwrapToken = env.RAVN_UNWRAP_TOKEN?.trim() || null;
  const accessTokenOnly = env.RAVN_ACCESS_TOKEN_ONLY?.trim() || null;
  if (unwrapToken && accessTokenOnly) {
    throw new ConfigError("set RAVN_UNWRAP_TOKEN or RAVN_ACCESS_TOKEN_ONLY, not both");
  }
  const ravnUrl = (env.RAVN_URL?.trim() || DEFAULT_RAVN_URL).replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/.test(ravnUrl)) {
    throw new ConfigError(`RAVN_URL must be an http(s) URL, got "${ravnUrl}"`);
  }
  return {
    port,
    host,
    secret,
    showValues,
    retentionHours,
    publicBaseUrl,
    viewToken,
    viewTokenFromEnv,
    fetchSchema: flags.get("no-fetch-schema") !== true,
    ravnUrl,
    unwrapToken,
    accessTokenOnly,
    stateFile: env.RAVN_STATE_FILE?.trim() || DEFAULT_STATE_FILE,
    answerStages: stagesOf(env.ANSWER_STAGES),
  };
}

/** `ANSWER_STAGES`: unset or `all` is all six, `none` is none, else a comma-separated list. */
function stagesOf(raw: string | undefined): HookableStage[] {
  const text = raw?.trim().toLowerCase();
  if (!text || text === "all") return [...HOOKABLE];
  if (text === "none") return [];
  const out: HookableStage[] = [];
  for (const s of text.split(",").map((x) => x.trim())) {
    if (!s) continue;
    if (!isHookable(s)) {
      throw new ConfigError(`ANSWER_STAGES: "${s}" is not one of ${HOOKABLE.join(", ")}`);
    }
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function integer(raw: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw.trim())) throw new ConfigError(`${name} must be an integer, got "${raw}"`);
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return n;
}
