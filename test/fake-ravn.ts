import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { HOOKABLE, type HookableStage } from "../src/stages.js";
import { CANARY } from "./fixtures.js";
import { schema } from "./helpers.js";

/**
 * A stand-in for the three Ravn surfaces a service account uses, behaving as
 * the spec says they do: svc-iam's `redeemUnwrap` and `renew` (one-time unwrap
 * tokens, rotating refresh tokens, a reused one revokes the chain), connect's
 * answer route (problem+json refusals with paths), and its MCP server.
 *
 * Every token it mints carries SECRET_MARK, and every MCP answer carries the
 * fixtures' canary in its values, so a test can tell if either ever reaches
 * the viewer or a log.
 */
export const SECRET_MARK = "SECRETMARK9c1e";

export interface AnswerCall {
  token: string;
  body: { stageRunId: string; attempt: number; out: unknown };
  status: number;
  code: string;
}

export class FakeRavn {
  base = "";
  /** Unwrap tokens not yet redeemed. */
  readonly unwrap = new Set<string>();
  readonly access = new Set<string>();
  /** Every refresh token ever issued → its chain; `live` holds each chain's current one. */
  private readonly chainOf = new Map<string, number>();
  private readonly live = new Map<number, string>();
  private readonly revokedChains = new Set<number>();
  private chains = 0;
  expiresIn = 900;
  redeems = 0;
  renews = 0;
  readonly answers: AnswerCall[] = [];
  readonly mcp: { token: string; method: string; tool?: string; args?: unknown }[] = [];
  /** Stage runs whose deadline has passed: an answer to one is `late`. */
  readonly late = new Set<string>();
  private readonly accepted = new Map<string, string>();
  private close_: () => Promise<void> = async () => {};

  newUnwrapToken(): string {
    const t = `rvu_${SECRET_MARK}-${randomBytes(6).toString("hex")}`;
    this.unwrap.add(t);
    return t;
  }

  /** Make every access token minted so far fail with 401, as an expired or revoked one would. */
  expireAccessTokens(): void {
    this.access.clear();
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req).then(({ status, body, type }) => {
        res.writeHead(status, { "content-type": type ?? "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    this.close_ = () => new Promise<void>((r) => server.close(() => r()));
  }

  close(): Promise<void> {
    return this.close_();
  }

  private mint(chain: number) {
    const accessToken = `access-${SECRET_MARK}-${randomBytes(6).toString("hex")}`;
    const refreshToken = `refresh-${SECRET_MARK}-${randomBytes(6).toString("hex")}`;
    this.access.add(accessToken);
    this.chainOf.set(refreshToken, chain);
    this.live.set(chain, refreshToken);
    return {
      success: true,
      code: null,
      message: "ok",
      accessToken,
      expiresIn: this.expiresIn,
      refreshToken,
      refreshExpiresAt: "2099-01-01T00:00:00.000Z",
    };
  }

  private refuse(code: string) {
    return { success: false, code, message: `refused: ${code}` };
  }

  private async handle(
    req: IncomingMessage,
  ): Promise<{ status: number; body?: unknown; type?: string }> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";

    if (req.url === "/api/gateway/graphql") {
      const query = String(json.query);
      const vars = (json.variables ?? {}) as Record<string, string>;
      if (query.includes("redeemUnwrap(")) {
        this.redeems++;
        const t = vars.t ?? "";
        if (!this.unwrap.has(t)) return gql("redeemUnwrap", this.refuse("used"));
        this.unwrap.delete(t);
        return gql("redeemUnwrap", this.mint(++this.chains));
      }
      if (query.includes("renew(")) {
        this.renews++;
        const r = vars.r ?? "";
        const chain = this.chainOf.get(r);
        if (chain === undefined) return gql("renew", this.refuse("invalid"));
        if (this.revokedChains.has(chain)) return gql("renew", this.refuse("revoked"));
        if (this.live.get(chain) !== r) {
          this.revokedChains.add(chain);
          return gql("renew", this.refuse("reused"));
        }
        return gql("renew", this.mint(chain));
      }
      return { status: 400, body: { errors: [{ message: "unknown" }] } };
    }

    if (req.url === "/api/connect/hooks/v1/answers") {
      if (!this.access.has(bearer)) {
        return problem(401, "unauthorized");
      }
      const body = json as AnswerCall["body"];
      const record = (status: number, code: string, extra: Record<string, unknown> = {}) => {
        this.answers.push({ token: bearer, body, status, code });
        return status === 200
          ? { status, body: { answer: code, stage: stageOf(body.stageRunId), ...extra } }
          : problem(status, code, extra);
      };
      const stage = stageOf(body.stageRunId);
      if (!stage) return record(404, "not_found");
      const verdict = schema.validateAnswer(stage, body);
      if (!verdict.valid) {
        return record(422, "schema_invalid", { paths: verdict.failures.map((f) => f.path) });
      }
      if (this.late.has(body.stageRunId)) return record(409, "late");
      const key = `${body.stageRunId}#${body.attempt}`;
      const prior = this.accepted.get(key);
      const same = JSON.stringify(body.out);
      if (prior !== undefined) {
        return prior === same
          ? record(200, "accepted", { replayed: true })
          : record(409, "already_answered");
      }
      this.accepted.set(key, same);
      return record(200, "accepted", { replayed: false });
    }

    if (req.url === "/api/connect/mcp/v1") {
      const method = String(json.method);
      const params = (json.params ?? {}) as { name?: string; arguments?: unknown };
      this.mcp.push({
        token: bearer,
        method,
        ...(params.name ? { tool: params.name, args: params.arguments } : {}),
      });
      if (!this.access.has(bearer)) {
        return {
          status: 401,
          body: {
            jsonrpc: "2.0",
            id: json.id ?? null,
            error: { code: -32001, message: "Unauthorized" },
          },
        };
      }
      if (json.id === undefined) return { status: 202 };
      const ok = (result: unknown) => ({
        status: 200,
        body: { jsonrpc: "2.0", id: json.id, result },
      });
      if (method === "initialize") {
        return ok({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake" },
        });
      }
      if (method !== "tools/call") return ok({});
      const c = (label: string) => `${CANARY}-mcp-${label}`;
      const structured: Record<string, Record<string, unknown>> = {
        get_case: {
          answer: "2-packets",
          case: { reportId: c("report"), externalRef: c("ref") },
          packets: [{ title: c("title") }, { title: c("title-2") }],
        },
        get_reporter_facts: {
          answer: "1-facts",
          reporter: { source: c("source"), externalId: c("id") },
          facts: [{ fact: c("fact"), value: c("value"), trust: "VERIFIED" }],
        },
        find_similar: {
          answer: "similar",
          similar: {
            thisProgram: { value: [{ reportId: c("similar"), outcome: "accepted" }] },
            otherPrograms: { value: null, reason: "too-few" },
            // A map keyed by data: its keys must not be kept.
            [`${CANARY}-keyed`]: [1, 2, 3],
          },
        },
        lookup_precedents: { answer: "not-kept", precedents: { value: null, reason: "not-kept" } },
      };
      const sc = structured[params.name ?? ""];
      return ok({
        content: [{ type: "text", text: c("text") }],
        structuredContent: { asOf: "2026-01-01T00:00:00.000Z", computedAt: "now", ...sc },
      });
    }
    return { status: 404, body: { error: "not found" } };
  }
}

function gql(field: string, payload: unknown) {
  return { status: 200, body: { data: { iam: { [field]: payload } } } };
}

function problem(status: number, code: string, extra: Record<string, unknown> = {}) {
  return {
    status,
    type: "application/problem+json",
    body: { type: "about:blank", title: code, status, code, ...extra },
  };
}

/** The fixtures name each run `<canary>-run-<stage>`. */
function stageOf(stageRunId: string): HookableStage | null {
  return HOOKABLE.find((s) => stageRunId.endsWith(`-run-${s}`)) ?? null;
}
