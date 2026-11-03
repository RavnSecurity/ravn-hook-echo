import { createHash } from "node:crypto";
import {
  type AnswerRecord,
  answerOut,
  type Delivered,
  describePlan,
  readAnswerReply,
} from "./answers.js";
import { answerPlan } from "./modes.js";
import type { Ops } from "./ops.js";
import type { StageSchema } from "./schema.js";
import type { HookableStage } from "./stages.js";
import type { DeliveryRecord } from "./store.js";

/**
 * Open mode (`ECHO_MODE=open`): the one Ravn-run echo, for every org at once,
 * with nothing to set up (ravn-platform#821).
 *
 * There is no signing secret and no service account. A delivery to a hook
 * Ravn flagged as *Ravn echo* carries two headers:
 *
 *   Ravn-Answer-Token  an opaque token Ravn minted for this stage run. The
 *                      echo answers with `Authorization: RavnAnswer <token>`,
 *                      and only Ravn can tell whether it is genuine.
 *   Ravn-Echo-View     sha256 hex of the hook's view key. The key itself is
 *                      only ever in the viewer link Ravn shows the org.
 *
 * The echo cannot verify either. So it stores a delivery **only once Ravn has
 * accepted its answer** (2xx): that is the proof the post came from Ravn. A
 * forged post costs an answer Ravn refuses, and leaves nothing behind.
 *
 * What is stored is in memory only: the last 50 per hook, for 24 hours, the
 * packet's shape and never its values. The viewer presents the key, and gets
 * back only the entries whose hash it matches.
 */

export const ANSWER_TOKEN_HEADER = "ravn-answer-token";
export const ECHO_VIEW_HEADER = "ravn-echo-view";
export const ANSWER_AUTH_SCHEME = "RavnAnswer";

/** A token Ravn mints is two base64url parts and a dot; anything else is not one of its. */
const TOKEN_RE = /^[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,512}$/;
const VIEW_HASH_RE = /^[0-9a-f]{64}$/;

export function answerTokenOf(raw: string | null): string | null {
  const t = raw?.trim() ?? "";
  return TOKEN_RE.test(t) ? t : null;
}

export function viewHashOf(raw: string | null): string | null {
  const h = raw?.trim().toLowerCase() ?? "";
  return VIEW_HASH_RE.test(h) ? h : null;
}

/** What Ravn sends as `Ravn-Echo-View` for a key: sha256 of the key's text, hex. */
export function hashViewKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** The hook a packet was sent to: `impl.hookId`, when `impl` names a hook. */
export function hookIdOf(envelope: unknown): string | null {
  const impl = (envelope as { impl?: { kind?: unknown; hookId?: unknown } } | null)?.impl;
  if (impl?.kind !== "hook" || typeof impl.hookId !== "string") return null;
  const id = impl.hookId;
  return id.length > 0 && id.length <= 200 ? id : null;
}

/** A stored delivery: one Ravn accepted an answer for. */
export interface OpenRecord extends DeliveryRecord {
  hookId: string;
  /** Not sent to the viewer: it is how entries are found, not something to show. */
  viewHash: string;
  storedAt: number;
}

export const PER_HOOK = 50;
export const OPEN_RETENTION_HOURS = 24;

/** Accepted deliveries in memory, per hook: the newest `perHook`, gone after the retention window. */
export class OpenStore {
  /** By hookId, newest first. Map order is least recently written first, for eviction. */
  private readonly byHook = new Map<string, OpenRecord[]>();
  private seq = 0;
  private readonly retentionMs: number;
  readonly perHook: number;
  private readonly maxHooks: number;

  constructor(opts: { retentionHours?: number; perHook?: number; maxHooks?: number } = {}) {
    this.retentionMs = (opts.retentionHours ?? OPEN_RETENTION_HOURS) * 3_600_000;
    this.perHook = opts.perHook ?? PER_HOOK;
    this.maxHooks = opts.maxHooks ?? 10_000;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  add(record: OpenRecord, now = Date.now()): void {
    this.sweep(now);
    const list = this.byHook.get(record.hookId) ?? [];
    this.byHook.delete(record.hookId);
    list.unshift(record);
    if (list.length > this.perHook) list.length = this.perHook;
    this.byHook.set(record.hookId, list);
    while (this.byHook.size > this.maxHooks) {
      const oldest = this.byHook.keys().next().value;
      if (oldest === undefined) break;
      this.byHook.delete(oldest);
    }
  }

  /** The entries whose view hash is this one, newest first. A hash nothing matches gets nothing. */
  list(viewHash: string, now = Date.now()): OpenRecord[] {
    this.sweep(now);
    const out: OpenRecord[] = [];
    for (const list of this.byHook.values()) {
      for (const r of list) if (r.viewHash === viewHash) out.push(r);
    }
    return out.sort((a, b) => b.seq - a.seq);
  }

  /** Every entry, for tests. */
  all(now = Date.now()): OpenRecord[] {
    this.sweep(now);
    return [...this.byHook.values()].flat();
  }

  sweep(now = Date.now()): void {
    const cutoff = now - this.retentionMs;
    for (const [hook, list] of this.byHook) {
      const kept = list.filter((r) => r.storedAt >= cutoff);
      if (kept.length === 0) this.byHook.delete(hook);
      else if (kept.length !== list.length) this.byHook.set(hook, kept);
    }
  }
}

/** A delivery in open mode, once the hook has answered it `2xx`. */
export interface OpenDelivered extends Delivered {
  token: string;
  hookId: string;
  viewHash: string;
}

/** Answers with Ravn's answer token, and stores the delivery only if Ravn accepts. */
export class OpenAnswerer {
  private readonly answersUrl: string;
  private readonly stages: ReadonlySet<HookableStage>;
  private readonly schema: () => StageSchema;
  private readonly store: OpenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pending = new Set<Promise<void>>();
  private readonly ops: Ops | undefined;

  constructor(opts: {
    answersUrl: string;
    stages: ReadonlySet<HookableStage>;
    schema: () => StageSchema;
    store: OpenStore;
    fetchImpl?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** An `answer.sent` line and count per answer. */
    ops?: Ops;
  }) {
    this.ops = opts.ops;
    this.answersUrl = opts.answersUrl;
    this.stages = opts.stages;
    this.schema = opts.schema;
    this.store = opts.store;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep =
      opts.sleep ??
      ((ms) =>
        new Promise<void>((r) => {
          setTimeout(r, ms).unref();
        }));
  }

  get answerStages(): HookableStage[] {
    return [...this.stages];
  }

  /** Resolves once every answer started so far has finished. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /**
   * Answer in the background. Nothing is remembered about the delivery unless
   * Ravn accepts: not even that it was seen, so a forged post cannot mark a
   * real stage run as handled.
   */
  delivered(d: OpenDelivered): void {
    const stageRunId = d.envelope.stageRunId;
    const attempt = d.envelope.attempt;
    if (typeof stageRunId !== "string" || typeof attempt !== "number") return;
    const t = this.answer(d, stageRunId, attempt)
      .catch(() => {})
      .finally(() => this.pending.delete(t));
    this.pending.add(t);
  }

  private async answer(d: OpenDelivered, stageRunId: string, attempt: number): Promise<void> {
    const plan = answerPlan(d.mode);
    // `never` sends nothing, so Ravn accepts nothing, so nothing is stored.
    if (plan.kind === "never" || !this.stages.has(d.stage)) return;

    const out = answerOut(d.stage, d.echo, plan.invalid);
    const body = { stageRunId, attempt, out };
    const local = this.schema().validateAnswer(d.stage, body);
    const rec: AnswerRecord = {
      plan: describePlan(plan),
      state: "not-sent",
      out,
      localValid: local.valid,
      ...(local.valid ? {} : { localFailures: local.failures }),
    };
    if (plan.delayMs > 0) {
      rec.dueAt = new Date(this.now() + plan.delayMs).toISOString();
      await this.sleep(plan.delayMs);
    }

    const started = this.now();
    const sent = (status: number | null, code: string) =>
      this.ops?.answer({
        stage: d.stage,
        hookMode: "open",
        stageRunId,
        attempt,
        status,
        code,
        latencyMs: Math.max(0, this.now() - started),
      });
    let res: Response;
    try {
      res = await this.fetchImpl(this.answersUrl, {
        method: "POST",
        headers: {
          authorization: `${ANSWER_AUTH_SCHEME} ${d.token}`,
          "content-type": "application/json",
          accept: "application/json, application/problem+json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      sent(null, "network");
      return;
    }
    const reply = await readAnswerReply(res);
    sent(reply.status, reply.code);
    if (res.status < 200 || res.status >= 300) return;

    const at = this.now();
    rec.state = "sent";
    rec.sentAt = new Date(started).toISOString();
    rec.status = reply.status;
    rec.code = reply.code;
    if (reply.replayed) rec.replayed = true;
    rec.latencyMs = Math.max(0, at - started);
    this.store.add(
      {
        ...d.record,
        seq: this.store.nextSeq(),
        answer: rec,
        hookId: d.hookId,
        viewHash: d.viewHash,
        storedAt: at,
      },
      at,
    );
  }
}
