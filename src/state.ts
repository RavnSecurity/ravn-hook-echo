import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The state file (`RAVN_STATE_FILE`, mode 600): the service account's refresh
 * token chain and, when it was entered at the prompt, the hook's signing
 * secret. Each writer changes only its own keys and keeps the rest, so a
 * renew never drops the secret and saving the secret never drops the chain.
 */
export type State = Record<string, unknown>;

/** The file as JSON. Null when it is missing; "unreadable" when it is not a JSON object. */
export function readState(path: string): State | null | "unreadable" {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const s = JSON.parse(text) as unknown;
    return s && typeof s === "object" && !Array.isArray(s) ? (s as State) : "unreadable";
  } catch {
    return "unreadable";
  }
}

/**
 * Merge `patch` into the file (an `undefined` value removes the key), written
 * to a temporary file with mode 600 and renamed over: never half a token.
 * Throws what the filesystem threw.
 */
export function updateState(path: string, patch: State): void {
  const current = readState(path);
  const next: State = { ...(current && current !== "unreadable" ? current : {}), ...patch };
  for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
  const tmp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** A saved refresh token: then the service account renews from it at start. */
export function hasSavedRefreshToken(path: string): boolean {
  const s = readState(path);
  return (
    s === "unreadable" ||
    (s !== null && typeof s.refreshToken === "string" && s.refreshToken !== "")
  );
}

/** The signing secret entered at an earlier prompt, if any. */
export function savedHookSecret(path: string): string | null {
  const s = readState(path);
  return s && s !== "unreadable" && typeof s.hookSecret === "string" && s.hookSecret
    ? s.hookSecret
    : null;
}

export function saveHookSecret(path: string, secret: string | undefined): void {
  updateState(path, { hookSecret: secret });
}
