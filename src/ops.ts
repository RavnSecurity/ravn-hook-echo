/**
 * The operator's view: one JSON line on stdout per delivery and per answer,
 * for Loki, and counters for Prometheus at `/metrics`.
 *
 * ❗Codes and ids only. Never a packet value, a token, a view key or its
 * hash, a secret, or an answer body. Every string that reaches a line or a
 * label goes through `idOf` or `codeOf` first: a header or packet field that
 * isn't shaped like an id or a code is logged as null, so whatever a sender
 * puts there cannot reach the log store.
 */

/** Ids from Ravn: uuids, `dlv_…`, `run_…`. Anything else is not logged. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Ravn's answer codes (`accepted`, `late`, `http-502`, …). Anything else is `other`. */
const CODE_RE = /^[a-z][a-z0-9_-]{0,39}$/;

export function idOf(v: unknown): string | null {
  return typeof v === "string" && ID_RE.test(v) ? v : null;
}

export function codeOf(v: unknown): string {
  return typeof v === "string" && CODE_RE.test(v) ? v : "other";
}

/** How a delivery was handled. A fixed set, so it is safe as a label. */
export type DeliveryOutcome =
  | "ok"
  | "schema_invalid"
  | "mode_status"
  | "no_stage"
  | "unauthorized"
  | "not_configured"
  | "too_large";

export interface DeliveryEvent {
  /** A hookable stage, or null when neither the URL nor x-ravn-event names one. */
  stage: string | null;
  outcome: DeliveryOutcome;
  /** The status the hook replied with. */
  status: number;
  /** `signed` or `open`. */
  hookMode: "signed" | "open";
  /** The URL's failure mode (`normal`, `fail/always`, …). */
  mode: string | null;
  deliveryId: string | null;
  attempt: number | null;
  /** Signed mode: whether x-ravn-signature was present. */
  signature?: boolean;
  /** Open mode: whether Ravn-Answer-Token and Ravn-Echo-View were both present and well formed. */
  token?: boolean;
  /** Null: not checked (refused before, or not JSON). */
  schemaOk: boolean | null;
}

export interface AnswerEvent {
  stage: string;
  hookMode: "signed" | "open";
  stageRunId: string | null;
  attempt: number | null;
  /** Ravn's HTTP status, or null when nothing came back. */
  status: number | null;
  /** Ravn's code, or `network` / `no-token` when nothing came back. */
  code: string;
  latencyMs: number;
}

type Labels = Record<string, string>;

class Counter {
  private readonly values = new Map<string, { labels: Labels; n: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels): void {
    const key = JSON.stringify(labels);
    const v = this.values.get(key);
    if (v) v.n += 1;
    else this.values.set(key, { labels, n: 1 });
  }

  get(labels: Labels): number {
    return this.values.get(JSON.stringify(labels))?.n ?? 0;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, n } of this.values.values()) {
      const l = Object.entries(labels)
        .map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
        .join(",");
      lines.push(`${this.name}{${l}} ${n}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

export class Ops {
  private readonly write: (line: string) => void;
  private readonly now: () => number;
  readonly deliveries = new Counter(
    "echo_deliveries_total",
    "Deliveries to a hook URL, by stage and how they were handled.",
  );
  readonly answers = new Counter(
    "echo_answers_total",
    "Answers sent to Ravn, by stage and Ravn's code.",
  );
  readonly clears = new Counter(
    "echo_view_cleared_total",
    "Clears from the viewer's DELETE /api/deliveries, by hook mode.",
  );

  constructor(opts: { write?: (line: string) => void; now?: () => number } = {}) {
    this.write = opts.write ?? ((line) => process.stdout.write(line));
    this.now = opts.now ?? Date.now;
  }

  delivery(e: DeliveryEvent): void {
    const stage = e.stage ?? "none";
    this.deliveries.inc({ stage, outcome: e.outcome });
    this.line("delivery.received", {
      stage: e.stage,
      outcome: e.outcome,
      status: e.status,
      hookMode: e.hookMode,
      mode: e.mode,
      deliveryId: idOf(e.deliveryId),
      attempt: e.attempt,
      ...(e.signature !== undefined ? { signature: e.signature } : {}),
      ...(e.token !== undefined ? { token: e.token } : {}),
      schemaOk: e.schemaOk,
    });
  }

  answer(e: AnswerEvent): void {
    const code = codeOf(e.code);
    this.answers.inc({ stage: e.stage, code });
    this.line("answer.sent", {
      stage: e.stage,
      hookMode: e.hookMode,
      stageRunId: idOf(e.stageRunId),
      attempt: e.attempt,
      status: e.status,
      code,
      latencyMs: e.latencyMs,
    });
  }

  /**
   * The viewer's clear route dropped `dropped` entries. A count only: never
   * the view key, its hash, the view token, or which hooks held them.
   */
  cleared(e: { hookMode: "signed" | "open"; dropped: number }): void {
    this.clears.inc({ mode: e.hookMode });
    this.line("view.cleared", { hookMode: e.hookMode, dropped: e.dropped });
  }

  /** The Prometheus text exposition. */
  metrics(): string {
    return this.deliveries.render() + this.answers.render() + this.clears.render();
  }

  private line(event: string, fields: Record<string, unknown>): void {
    this.write(`${JSON.stringify({ at: new Date(this.now()).toISOString(), event, ...fields })}\n`);
  }
}

/** For tests and callers that want no output: counts, and writes nothing. */
export function silentOps(): Ops {
  return new Ops({ write: () => {} });
}
