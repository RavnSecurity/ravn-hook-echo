import type { AnswerRecord } from "./answers.js";
import type { EchoSeed } from "./echo.js";
import type { ReadRecord } from "./mcp.js";
import type { SchemaFailure } from "./schema.js";
import type { Shape } from "./shape.js";
import type { HookableStage } from "./stages.js";

/** One attempt of one delivery, as the viewer shows it. Only signed deliveries are ever stored. */
export interface DeliveryRecord {
  /** This server's own sequence number, newest highest. */
  seq: number;
  receivedAt: string;
  path: string;
  mode: string;
  stage: HookableStage | null;
  event: string | null;
  deliveryId: string | null;
  /** `x-ravn-attempt` as sent, or null when absent. */
  attempt: number | null;
  /** How many times this delivery id had been seen before, counting this one. */
  seen: number;
  /** True when the same `x-ravn-delivery` was already received: a retry. */
  duplicate: boolean;
  signatureValid: true;
  /** Null when the body did not parse. */
  schemaValid: boolean | null;
  schemaFailures: SchemaFailure[];
  parseError: string | null;
  inputDigest: string | null;
  seed: EchoSeed | null;
  echo: Record<string, unknown> | null;
  response: { status: number; note: string };
  latencyMs: number;
  /** The packet's shape: keys, types, and each empty value's reason. Never a value. */
  shape: Shape | null;
  /** The packet itself. Set only with `--show-values`, which needs a loopback bind. */
  body?: unknown;
  /** The answer sent back as the service account, and Ravn's reply code. Filled in after the response. */
  answer?: AnswerRecord;
  /** The MCP reads made after the delivery: codes and counts only. */
  reads?: ReadRecord[];
}

/**
 * Deliveries in memory, newest first, gone after the retention window. The
 * cap bounds a public instance's memory whatever is thrown at it.
 */
export class DeliveryStore {
  private records: DeliveryRecord[] = [];
  private seq = 0;
  private readonly retentionMs: number;
  private readonly max: number;

  constructor(opts: { retentionHours: number; max?: number }) {
    this.retentionMs = Math.max(0, opts.retentionHours) * 3_600_000;
    this.max = opts.max ?? 5_000;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** How many stored attempts carried this delivery id. */
  seen(deliveryId: string | null, now = Date.now()): number {
    if (deliveryId === null) return 0;
    this.sweep(now);
    return this.records.filter((r) => r.deliveryId === deliveryId).length;
  }

  add(record: DeliveryRecord, now = Date.now()): void {
    this.sweep(now);
    this.records.unshift(record);
    if (this.records.length > this.max) this.records.length = this.max;
  }

  list(now = Date.now()): DeliveryRecord[] {
    this.sweep(now);
    return this.records.slice();
  }

  sweep(now = Date.now()): void {
    const cutoff = now - this.retentionMs;
    this.records = this.records.filter((r) => Date.parse(r.receivedAt) >= cutoff);
  }
}
