import { randomBytes } from "node:crypto";

export interface Config {
  port: number;
  host: string;
  /** The signing secret Ravn shows once. Required: an unsigned endpoint on the internet stores nothing. */
  secret: string;
  showValues: boolean;
  retentionHours: number;
  publicBaseUrl: string;
  viewToken: string;
  /** Fetch the schema from its `$id` at start. Off keeps the vendored copy (tests, air-gapped runs). */
  fetchSchema: boolean;
}

export class ConfigError extends Error {}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.trim().toLowerCase());
}

export const USAGE = `ravn-hook-echo — a reference Ravn Hook for every triage stage

  ravn-hook-echo [--port N] [--host H] [--show-values] [--no-fetch-schema]

Environment
  RAVN_HOOK_SECRET  the signing secret Ravn showed when the hook was created (required)
  PORT              listen port (default 8080)
  HOST              bind address (default 0.0.0.0)
  VIEW_TOKEN        the viewer's bearer token; generated and printed once when unset
  RETENTION_HOURS   how long deliveries stay in memory (default 24)
  PUBLIC_BASE_URL   the URL Ravn reaches this hook on, for the printed addresses

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

  const secret = env.RAVN_HOOK_SECRET ?? "";
  if (!secret)
    throw new ConfigError("RAVN_HOOK_SECRET is not set: the hook cannot verify deliveries");

  const port = integer(String(flags.get("port") ?? env.PORT ?? "8080"), "PORT", 0, 65535);
  const host = String(flags.get("host") ?? env.HOST ?? "0.0.0.0");
  const showValues = flags.get("show-values") === true;
  if (showValues && !isLoopback(host)) {
    throw new ConfigError(
      `--show-values is refused on ${host}: it is for your own laptop. Bind to 127.0.0.1 or ::1.`,
    );
  }
  const retentionHours = integer(env.RETENTION_HOURS ?? "24", "RETENTION_HOURS", 0, 24 * 365);
  const viewToken = env.VIEW_TOKEN?.trim() || randomBytes(16).toString("hex");
  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const publicBaseUrl = (env.PUBLIC_BASE_URL?.trim() || `http://${displayHost}:${port}`).replace(
    /\/+$/,
    "",
  );
  return {
    port,
    host,
    secret,
    showValues,
    retentionHours,
    publicBaseUrl,
    viewToken,
    fetchSchema: flags.get("no-fetch-schema") !== true,
  };
}

function integer(raw: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw.trim())) throw new ConfigError(`${name} must be an integer, got "${raw}"`);
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return n;
}
