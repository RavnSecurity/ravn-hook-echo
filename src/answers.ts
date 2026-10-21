import type { AccountStatus, ServiceAccount } from "./account.js";
import { type McpReader, READ_TOOLS, type ReadContext, type ReadRecord } from "./mcp.js";
import { type AnswerPlan, answerPlan, type Mode } from "./modes.js";
import type { SchemaFailure, StageSchema } from "./schema.js";
import type { HookableStage } from "./stages.js";
import type { DeliveryRecord } from "./store.js";

/**
 * Answering back, as the service account.
 *
 * A packet Ravn sends names its stage run (`stageRunId`) and that run's
 * `attempt`. Once a delivery is answered `2xx`, the hook answers the run with
 * its echo output: `POST /api/connect/hooks/v1/answers` with
 * `{ stageRunId, attempt, out }`. Ravn checks it against the published
 * `<Stage>Answer` and replies with a code: `accepted`, or why not (`late`,
 * `schema_invalid` with JSON paths into `out`, `not_allowed`, …).
 *
 * The answer is never the delivery's HTTP response: Ravn ignores that. An
 * answer is an act by an identity, and a URL is not one.
 *
 * Each stage run is answered once, however many times its packet is
 * delivered: a retried delivery is the same run. The same answer twice would
 * be harmless (Ravn replays the first result) but says nothing new.
 */

/** What the viewer shows of an answer. `out` is the echo output, which carries no packet value. */
export interface AnswerRecord {
  /** `now`, `late <n>ms`, `invalid`, or `never`. */
  plan: string;
  state: "not-sent" | "scheduled" | "sent";
  /** Why it was not sent, when it was not. */
  reason?: string;
  dueAt?: string;
  sentAt?: string;
  out?: unknown;
  /** Whether `{ stageRunId, attempt, out }` passed the published `<Stage>Answer` here, before sending. */
  localValid?: boolean;
  localFailures?: SchemaFailure[];
  /** Ravn's reply. */
  status?: number | null;
  code?: string;
  paths?: string[];
  replayed?: boolean;
  latencyMs?: number;
}

export interface RavnUrls {
  /** `https://apps.ravnsecurity.io/api/gateway/graphql` */
  gateway: string;
  /** `https://apps.ravnsecurity.io/api/connect/hooks/v1/answers` */
  answers: string;
  /** `https://apps.ravnsecurity.io/api/connect/mcp/v1` */
  mcp: string;
}

export function ravnUrls(base: string): RavnUrls {
  const b = base.replace(/\/+$/, "");
  return {
    gateway: `${b}/api/gateway/graphql`,
    answers: `${b}/api/connect/hooks/v1/answers`,
    mcp: `${b}/api/connect/mcp/v1`,
  };
}

/** What a delivery hands over once it is answered. Values here go to Ravn, never to the viewer. */
export interface Delivered {
  record: DeliveryRecord;
  mode: Mode;
  stage: HookableStage;
  envelope: Record<string, unknown>;
  echo: Record<string, unknown>;
}

const MAX_REMEMBERED = 10_000;

export class Ravn {
  private readonly account: ServiceAccount;
  private readonly reader: McpReader;
  private readonly answersUrl: string;
  private readonly stages: ReadonlySet<HookableStage>;
  private readonly schema: () => StageSchema;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Stage runs already handled, `<stageRunId>#<attempt>`, oldest first. */
  private readonly handled = new Set<string>();
  /** Each case's reporter, from the packet that named it, for the reads of later stages. */
  private readonly reporters = new Map<string, { source: string; externalId: string }>();
  private readonly pending = new Set<Promise<void>>();

  constructor(opts: {
    account: ServiceAccount;
    reader: McpReader;
    answersUrl: string;
    stages: ReadonlySet<HookableStage>;
    schema: () => StageSchema;
    fetchImpl?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.account = opts.account;
    this.reader = opts.reader;
    this.answersUrl = opts.answersUrl;
    this.stages = opts.stages;
    this.schema = opts.schema;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep =
      opts.sleep ??
      ((ms) =>
        new Promise<void>((r) => {
          setTimeout(r, ms).unref();
        }));
  }

  status(): AccountStatus & { answerStages: HookableStage[] } {
    return { ...this.account.status(), answerStages: [...this.stages] };
  }

  /** Resolves once every answer and read started so far has finished. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /**
   * After a delivery has been answered `2xx`: answer the stage run and read
   * over MCP, in the background. The record is filled in as results arrive.
   */
  delivered(d: Delivered): void {
    const stageRunId = d.envelope.stageRunId;
    const attempt = d.envelope.attempt;
    if (typeof stageRunId !== "string" || typeof attempt !== "number") return;
    this.rememberReporter(d.envelope);

    const key = `${stageRunId}#${attempt}`;
    const plan = answerPlan(d.mode);
    if (this.handled.has(key)) {
      d.record.answer = {
        plan: describePlan(plan),
        state: "not-sent",
        reason: "this stage run was already answered: the delivery is a retry",
      };
      return;
    }
    this.handled.add(key);
    if (this.handled.size > MAX_REMEMBERED) {
      const oldest = this.handled.values().next().value;
      if (oldest !== undefined) this.handled.delete(oldest);
    }

    this.track(this.answer(d, plan, stageRunId, attempt));
    this.track(this.read(d));
  }

  private track(p: Promise<void>): void {
    const t = p.catch(() => {}).finally(() => this.pending.delete(t));
    this.pending.add(t);
  }

  private async answer(
    d: Delivered,
    plan: AnswerPlan,
    stageRunId: string,
    attempt: number,
  ): Promise<void> {
    const rec: AnswerRecord = { plan: describePlan(plan), state: "not-sent" };
    d.record.answer = rec;
    if (plan.kind === "never") {
      rec.reason = "never mode: received, and deliberately not answered";
      return;
    }
    if (!this.stages.has(d.stage)) {
      rec.reason = `ANSWER_STAGES does not include ${d.stage}`;
      return;
    }

    const out = answerOut(d.stage, d.echo, plan.invalid);
    const body = { stageRunId, attempt, out };
    const local = this.schema().validateAnswer(d.stage, body);
    rec.out = out;
    rec.localValid = local.valid;
    if (!local.valid) rec.localFailures = local.failures;

    if (plan.delayMs > 0) {
      rec.state = "scheduled";
      rec.dueAt = new Date(this.now() + plan.delayMs).toISOString();
      await this.sleep(plan.delayMs);
    }

    const started = this.now();
    rec.sentAt = new Date(started).toISOString();
    const reply = await this.post(body);
    rec.state = "sent";
    rec.status = reply.status;
    rec.code = reply.code;
    if (reply.paths) rec.paths = reply.paths;
    if (reply.replayed) rec.replayed = true;
    rec.latencyMs = Math.max(0, this.now() - started);
  }

  private async post(
    body: Record<string, unknown>,
  ): Promise<{ status: number | null; code: string; paths?: string[]; replayed?: boolean }> {
    let token = await this.account.accessToken();
    if (!token) return { status: null, code: "no-token" };
    for (let tries = 0; ; tries++) {
      let res: Response;
      try {
        res = await this.fetchImpl(this.answersUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, application/problem+json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        return { status: null, code: "network" };
      }
      if (res.status === 401 && tries === 0) {
        const next = await this.account.unauthorized(token);
        if (next) {
          token = next;
          continue;
        }
      }
      let json: Record<string, unknown> = {};
      try {
        json = (await res.json()) as Record<string, unknown>;
      } catch {}
      const code =
        typeof json.answer === "string"
          ? json.answer
          : typeof json.code === "string"
            ? json.code
            : `http-${res.status}`;
      const paths = Array.isArray(json.paths)
        ? json.paths
            .filter((p): p is string => typeof p === "string")
            .slice(0, 50)
            .map((p) => p.slice(0, 200))
        : undefined;
      return {
        status: res.status,
        code,
        ...(paths ? { paths } : {}),
        ...(json.replayed === true ? { replayed: true } : {}),
      };
    }
  }

  private async read(d: Delivered): Promise<void> {
    const ctx = this.readContext(d.envelope);
    if (!ctx) return;
    d.record.reads = READ_TOOLS.map((tool) => ({
      tool,
      status: null,
      code: "pending",
      isError: false,
      counts: {},
      latencyMs: 0,
    }));
    const reads: ReadRecord[] = await this.reader.readAll(ctx);
    d.record.reads = reads;
  }

  private readContext(env: Record<string, unknown>): ReadContext | null {
    const { reportId, asOf } = env;
    if (typeof reportId !== "string" || typeof asOf !== "string") return null;
    return { reportId, asOf, reporter: this.reporters.get(reportId) ?? null };
  }

  /** Classify's packet names the reporter's account; later stages' don't, so it is remembered by case. */
  private rememberReporter(env: Record<string, unknown>): void {
    const reportId = env.reportId;
    const account = (env.packet as { report?: { account?: { value?: unknown } } } | undefined)
      ?.report?.account?.value as { source?: unknown; externalId?: unknown } | null | undefined;
    if (
      typeof reportId === "string" &&
      typeof account?.source === "string" &&
      typeof account.externalId === "string"
    ) {
      this.reporters.set(reportId, { source: account.source, externalId: account.externalId });
      if (this.reporters.size > MAX_REMEMBERED) {
        const oldest = this.reporters.keys().next().value;
        if (oldest !== undefined) this.reporters.delete(oldest);
      }
    }
  }
}

function describePlan(plan: AnswerPlan): string {
  if (plan.kind === "never") return "never";
  if (plan.invalid) return "invalid";
  return plan.delayMs > 0 ? `late ${plan.delayMs}ms` : "now";
}

/** The marker key an invalid answer carries. The schema declares no such key. */
export const INVALID_KEY = "echoInvalid";

/**
 * The `out` an answer carries: the echo output, as a one-line list for
 * Follow-up (one answer carries every release line the hook knows). For
 * `/answer-invalid`, the same with its first required key removed and an
 * undeclared key added, so Ravn's refusal names two paths.
 */
export function answerOut(
  stage: HookableStage,
  echo: Record<string, unknown>,
  invalid: boolean,
): unknown {
  const one = invalid ? invalidate(echo) : echo;
  return stage === "follow-up" ? [one] : one;
}

function invalidate(echo: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...echo, [INVALID_KEY]: true };
  const first = Object.keys(echo)[0];
  if (first !== undefined) delete out[first];
  return out;
}
