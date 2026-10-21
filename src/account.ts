import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The hook as a service account: the identity it answers and reads as.
 *
 * An org admin creates a service account in Ravn and gets a one-time **unwrap
 * token**. On first start this hook redeems it, over Ravn's public GraphQL,
 * for an access token (15 minutes) and a refresh token (90 days from its last
 * use). From then on it renews: the current refresh token buys a new access
 * token and a **new** refresh token, and the old one is spent. Presenting a
 * spent refresh token again revokes the whole chain, because two holders of
 * one credential is a leak. So:
 *
 * - The refresh token is written to a local state file (mode 600) the moment
 *   it arrives, every time, before anything else uses the new access token.
 * - Only one renew is ever in flight. Two concurrent renews would present the
 *   same refresh token twice, and the second would revoke everything.
 * - No token is ever logged, printed, or shown in the viewer. A GraphQL error's
 *   message is never logged either: a server may quote a variable's value in it.
 *
 * `RAVN_ACCESS_TOKEN_ONLY` skips all of this for a quick test with an access
 * token you already have. It is never renewed, so it stops working when it
 * expires.
 */

/** Renew when the access token has less than this left. */
export const RENEW_BEFORE_MS = 60_000;
/** After a failed renew that may succeed later (svc-iam down, a network error), wait this long. */
export const RETRY_AFTER_MS = 30_000;

/** svc-iam's refusals that no retry fixes: the credential is dead. */
const TERMINAL = new Set([
  "invalid",
  "used",
  "expired",
  "revoked",
  "reused",
  "suspended",
  "not_allowed",
]);

const FIELDS = "success code message accessToken expiresIn refreshToken refreshExpiresAt";
export const REDEEM_UNWRAP = `mutation($t: String!) { iam { redeemUnwrap(token: $t) { ${FIELDS} } } }`;
export const RENEW = `mutation($r: String!) { iam { renew(refreshToken: $r) { ${FIELDS} } } }`;

export interface AccountOptions {
  /** `https://apps.ravnsecurity.io/api/gateway/graphql`, or a local stack's. */
  gatewayUrl: string;
  unwrapToken?: string | null;
  accessTokenOnly?: string | null;
  stateFile: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

/** What the viewer may know about the account. Never a token. */
export interface AccountStatus {
  mode: "unwrap" | "access-token-only";
  state: "starting" | "ok" | "failing";
  /** The last refusal or failure: svc-iam's code (`used`, `reused`, …), or `http-503`, `network`, … */
  code: string | null;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
  redeemedAt: string | null;
  lastRenewAt: string | null;
  renewals: number;
}

interface StateFile {
  refreshToken: string;
  refreshExpiresAt: string | null;
  /** A short sha256 of the unwrap token this chain came from, so a new one is noticed and redeemed. */
  unwrap: string | null;
  savedAt: string;
}

interface Tokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: string | null;
}

type Outcome = { ok: true; tokens: Tokens } | { ok: false; code: string };

export function unwrapFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16);
}

export class ServiceAccount {
  private readonly opts: AccountOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  private access: string | null = null;
  private accessExpiresAt = 0;
  private refresh: string | null = null;
  /** The fingerprint of the unwrap token this chain was redeemed from. */
  private unwrap: string | null = null;
  private renewing: Promise<string | null> | null = null;
  private retryAt = 0;
  private dead = false;
  private keepFreshTimer: NodeJS.Timeout | null = null;
  private readonly st: AccountStatus;

  constructor(opts: AccountOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.log(line));
    this.st = {
      mode: opts.accessTokenOnly ? "access-token-only" : "unwrap",
      state: "starting",
      code: null,
      accessExpiresAt: null,
      refreshExpiresAt: null,
      redeemedAt: null,
      lastRenewAt: null,
      renewals: 0,
    };
  }

  status(): AccountStatus {
    if (this.st.mode === "access-token-only" && this.access && this.now() >= this.accessExpiresAt) {
      return { ...this.st, state: "failing", code: "expired" };
    }
    return { ...this.st };
  }

  /**
   * Get the first access token: from the state file's refresh token when there
   * is one for this unwrap token, else by redeeming the unwrap token. Never
   * throws; a failure is in `status()` and the log.
   */
  async start(): Promise<void> {
    if (this.opts.accessTokenOnly) {
      this.access = this.opts.accessTokenOnly;
      this.accessExpiresAt = expiryOf(this.access) ?? Number.POSITIVE_INFINITY;
      this.st.state = "ok";
      this.st.accessExpiresAt = Number.isFinite(this.accessExpiresAt)
        ? new Date(this.accessExpiresAt).toISOString()
        : null;
      this.log("service account: using RAVN_ACCESS_TOKEN_ONLY; it is never renewed");
      return;
    }

    const unwrap = this.opts.unwrapToken ?? null;
    const saved = this.readState();
    // An unwrap token the saved chain did not come from is a new handover
    // (after *Revoke tokens*, say): redeem it. One it did come from is spent.
    if (unwrap !== null && saved?.unwrap !== unwrapFingerprint(unwrap)) {
      this.log(
        saved
          ? "service account: a new RAVN_UNWRAP_TOKEN; redeeming it"
          : "service account: redeeming RAVN_UNWRAP_TOKEN",
      );
      const outcome = await this.call(REDEEM_UNWRAP, { t: unwrap }, "redeemUnwrap");
      if (outcome.ok) {
        this.unwrap = unwrapFingerprint(unwrap);
        this.accept(outcome.tokens);
        this.st.redeemedAt = new Date(this.now()).toISOString();
        this.log("service account: redeemed; refresh token saved");
        return;
      }
      this.fail(outcome.code);
      this.log(`service account: redeemUnwrap refused: ${outcome.code}`);
      if (!saved) {
        this.dead = TERMINAL.has(outcome.code);
        return;
      }
    }
    if (saved) {
      this.refresh = saved.refreshToken;
      this.unwrap = saved.unwrap;
      this.st.refreshExpiresAt = saved.refreshExpiresAt;
      this.log(`service account: renewing from ${this.opts.stateFile}`);
      await this.renew();
      return;
    }
    this.fail("no-credential");
    this.log(
      "service account: no RAVN_UNWRAP_TOKEN and no saved refresh token; not answering or reading",
    );
  }

  /**
   * Renew shortly before the access token expires, so the chain stays alive
   * and the viewer shows its health even when no packet arrives.
   */
  keepFresh(): void {
    if (this.keepFreshTimer) clearTimeout(this.keepFreshTimer);
    if (this.dead || this.st.mode === "access-token-only") return;
    const due = this.access
      ? Math.max(1_000, this.accessExpiresAt - RENEW_BEFORE_MS - this.now())
      : RETRY_AFTER_MS;
    this.keepFreshTimer = setTimeout(async () => {
      await this.accessToken();
      this.keepFresh();
    }, due);
    this.keepFreshTimer.unref();
  }

  stop(): void {
    if (this.keepFreshTimer) clearTimeout(this.keepFreshTimer);
  }

  /** A usable access token, renewed first when it has under a minute left. Null when there is none. */
  async accessToken(): Promise<string | null> {
    if (this.st.mode === "access-token-only") return this.access;
    if (this.access && this.accessExpiresAt - this.now() > RENEW_BEFORE_MS) return this.access;
    return this.renewOnce();
  }

  /**
   * Ravn said 401 to `spent`. Renew, unless another caller already has since
   * that token was handed out. Returns the token to retry with, or null.
   */
  async unauthorized(spent: string): Promise<string | null> {
    if (this.st.mode === "access-token-only") return null;
    if (this.access && this.access !== spent) return this.access;
    this.accessExpiresAt = 0;
    return this.renewOnce();
  }

  /** One renew at a time: every concurrent caller waits on the same one. */
  private renewOnce(): Promise<string | null> {
    if (this.renewing) return this.renewing;
    if (this.dead || !this.refresh || this.now() < this.retryAt) {
      return Promise.resolve(this.access && this.now() < this.accessExpiresAt ? this.access : null);
    }
    this.renewing = this.renew()
      .then((ok) => (ok ? this.access : null))
      .finally(() => {
        this.renewing = null;
      });
    return this.renewing;
  }

  private async renew(): Promise<boolean> {
    const refresh = this.refresh;
    if (!refresh) return false;
    const outcome = await this.call(RENEW, { r: refresh }, "renew");
    if (!outcome.ok) {
      this.fail(outcome.code);
      if (TERMINAL.has(outcome.code)) {
        this.dead = true;
        this.refresh = null;
        this.log(`service account: renew refused: ${outcome.code}. Get a new unwrap token.`);
      } else {
        this.retryAt = this.now() + RETRY_AFTER_MS;
        this.log(`service account: renew failed: ${outcome.code}; retrying in 30s`);
      }
      return false;
    }
    this.accept(outcome.tokens);
    this.st.lastRenewAt = new Date(this.now()).toISOString();
    this.st.renewals += 1;
    return true;
  }

  /** New tokens: save the refresh token FIRST, then use the access token. */
  private accept(tokens: Tokens): void {
    this.refresh = tokens.refreshToken;
    this.saveState({
      refreshToken: tokens.refreshToken,
      refreshExpiresAt: tokens.refreshExpiresAt,
      unwrap: this.unwrap,
      savedAt: new Date(this.now()).toISOString(),
    });
    this.access = tokens.accessToken;
    this.accessExpiresAt = this.now() + tokens.expiresIn * 1000;
    this.retryAt = 0;
    this.st.state = "ok";
    this.st.code = null;
    this.st.accessExpiresAt = new Date(this.accessExpiresAt).toISOString();
    this.st.refreshExpiresAt = tokens.refreshExpiresAt;
  }

  private fail(code: string): void {
    this.st.state = "failing";
    this.st.code = code;
  }

  private async call(
    query: string,
    variables: Record<string, string>,
    field: "redeemUnwrap" | "renew",
  ): Promise<Outcome> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.gatewayUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return { ok: false, code: "network" };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, code: `http-${res.status}` };
    }
    const data = (json as { data?: { iam?: Record<string, unknown> } })?.data?.iam?.[field] as
      | Record<string, unknown>
      | undefined;
    if (!data) {
      // ❗Never the errors' messages: a GraphQL server may quote a variable's value.
      return { ok: false, code: res.ok ? "graphql-error" : `http-${res.status}` };
    }
    if (data.success !== true) {
      return { ok: false, code: typeof data.code === "string" ? data.code : "refused" };
    }
    const { accessToken, expiresIn, refreshToken, refreshExpiresAt } = data;
    if (
      typeof accessToken !== "string" ||
      typeof refreshToken !== "string" ||
      typeof expiresIn !== "number"
    ) {
      return { ok: false, code: "malformed" };
    }
    return {
      ok: true,
      tokens: {
        accessToken,
        expiresIn,
        refreshToken,
        refreshExpiresAt: typeof refreshExpiresAt === "string" ? refreshExpiresAt : null,
      },
    };
  }

  private readState(): StateFile | null {
    let text: string;
    try {
      text = readFileSync(this.opts.stateFile, "utf8");
    } catch {
      return null;
    }
    try {
      const s = JSON.parse(text) as Partial<StateFile>;
      if (typeof s.refreshToken !== "string" || !s.refreshToken) return null;
      return {
        refreshToken: s.refreshToken,
        refreshExpiresAt: typeof s.refreshExpiresAt === "string" ? s.refreshExpiresAt : null,
        unwrap: typeof s.unwrap === "string" ? s.unwrap : null,
        savedAt: typeof s.savedAt === "string" ? s.savedAt : "",
      };
    } catch {
      this.log(`service account: ${this.opts.stateFile} is not JSON; ignoring it`);
      return null;
    }
  }

  /** Written to a temporary file with mode 600, then renamed over: never half a token. */
  private saveState(state: StateFile): void {
    const path = this.opts.stateFile;
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } catch (e) {
      this.log(
        `service account: could not save ${path} (${(e as NodeJS.ErrnoException).code ?? "error"}). ` +
          "A restart will not be able to renew.",
      );
    }
  }
}

/** A JWT's `exp`, in ms, without verifying it: only to know when to stop using it. */
export function expiryOf(jwt: string): number | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const exp = (
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }
    ).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}
