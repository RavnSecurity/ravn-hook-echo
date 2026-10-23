import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Ravn } from "./answers.js";
import { echoOutput, seedOf } from "./echo.js";
import { decide, describeMode, parseRoute } from "./modes.js";
import type { SchemaFailure, StageSchema } from "./schema.js";
import { shapeOf } from "./shape.js";
import {
  ATTEMPT_HEADER,
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  verifySignature,
} from "./signature.js";
import { type HookableStage, stageOfEvent } from "./stages.js";
import type { DeliveryRecord, DeliveryStore } from "./store.js";
import { VIEW_CSS, VIEW_HTML, VIEW_JS, VIEWER_HEADERS } from "./viewer.js";

/** A packet is metadata only; 1 MiB is far more than any stage sends. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Why a delivery to an unconfigured hook is refused. */
export const NOT_CONFIGURED =
  "not configured: RAVN_HOOK_SECRET is not set, so this hook cannot verify deliveries";

export interface ServerDeps {
  /** Null: not configured. Every delivery is refused with 503, and nothing about it is stored. */
  secret: string | null;
  viewToken: string;
  showValues: boolean;
  retentionHours: number;
  version: string;
  store: DeliveryStore;
  /** The current schema. A function so a refreshed copy is picked up without a restart. */
  schema: () => StageSchema;
  schemaId: string;
  /** The service account's side: answers and MCP reads. Absent, the hook only receives. */
  ravn?: Ravn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createHookServer(deps: ServerDeps): Server {
  const server = createServer((req, res) => {
    handle(req, res, deps).catch(() => {
      // Never echo an error's text: it could carry a value from the request.
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.destroy();
    });
  });
  // A slow mode can hold a socket for up to MAX_SLOW_MS; nothing longer.
  server.requestTimeout = 150_000;
  server.headersTimeout = 20_000;
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://hook.invalid");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" || method === "HEAD") {
    switch (path) {
      case "/view":
      case "/view/":
        return viewer(res, 200, "text/html; charset=utf-8", VIEW_HTML);
      case "/view.js":
      case "/view/view.js":
        return viewer(res, 200, "text/javascript; charset=utf-8", VIEW_JS);
      case "/view.css":
      case "/view/view.css":
        return viewer(res, 200, "text/css; charset=utf-8", VIEW_CSS);
      case "/api/deliveries":
      case "/view/api/deliveries":
        return deliveries(req, res, deps);
      case "/healthz":
        // Always 200 while the process serves: the liveness probe restarts on anything else.
        return send(res, 200, { ok: true, configured: deps.secret !== null });
      case "/":
        return send(res, 200, {
          name: "ravn-hook-echo",
          about: "A reference Ravn Hook. POST a stage's packet to /<stage>; see the README.",
        });
    }
  }

  const route = parseRoute(path);
  if (!route) return send(res, 404, { error: "not a hook URL" });
  if (method !== "POST") {
    res.setHeader("allow", "POST");
    return send(res, 405, { error: "a hook URL takes POST" });
  }
  return receive(req, res, deps, path, route);
}

/** Every viewer response: no referrer, not indexed, not cached, nothing third-party. */
function viewer(res: ServerResponse, status: number, type: string, body: string): void {
  for (const [k, v] of Object.entries(VIEWER_HEADERS)) res.setHeader(k, v);
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function bearerMatches(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m?.[1]) return false;
  const a = Buffer.from(m[1], "utf8");
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function deliveries(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): void {
  if (!bearerMatches(req, deps.viewToken)) {
    res.setHeader("www-authenticate", "Bearer");
    viewer(res, 401, "application/json", JSON.stringify({ error: "bad or missing token" }));
    return;
  }
  const schema = deps.schema();
  const now = deps.now?.() ?? Date.now();
  const list = deps.store.list(now).map((r) => {
    if (deps.showValues) return r;
    // Belt and braces: a record never carries a body without --show-values,
    // and this strips one even if it somehow did.
    const { body: _body, ...rest } = r;
    return rest;
  });
  viewer(
    res,
    200,
    "application/json",
    JSON.stringify({
      schema: { id: deps.schemaId, source: schema.source.kind },
      retentionHours: deps.retentionHours,
      showValues: deps.showValues,
      configured: deps.secret !== null,
      account: deps.ravn?.status() ?? null,
      deliveries: list,
    }),
  );
}

async function readBody(req: IncomingMessage): Promise<Buffer | "too-large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_BODY_BYTES) return "too-large";
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

async function receive(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  path: string,
  route: NonNullable<ReturnType<typeof parseRoute>>,
): Promise<void> {
  // Not configured: refuse before reading anything. Ravn retries a 5xx, so
  // nothing is lost while the secret is on its way.
  if (deps.secret === null) return send(res, 503, { error: NOT_CONFIGURED });

  const started = deps.now?.() ?? Date.now();
  const body = await readBody(req);
  if (body === "too-large") return send(res, 413, { error: "body too large" });

  // 1. Verify. Unsigned or bad: 401, and nothing is stored.
  if (!verifySignature(body, header(req, SIGNATURE_HEADER) ?? undefined, deps.secret)) {
    return send(res, 401, { error: "missing or invalid x-ravn-signature" });
  }

  const event = header(req, EVENT_HEADER);
  const deliveryId = header(req, DELIVERY_HEADER);
  const attemptRaw = header(req, ATTEMPT_HEADER);
  const attempt = attemptRaw && /^\d{1,6}$/.test(attemptRaw) ? Number(attemptRaw) : null;

  // 2. Dedupe on x-ravn-delivery, stable across retries.
  const priorSeen = deps.store.seen(deliveryId, started);
  const seen = priorSeen + 1;
  const duplicate = priorSeen > 0;

  // Which stage: the URL's, or for POST / the one x-ravn-event names.
  const eventStage = stageOfEvent(event ?? undefined);
  let stage: HookableStage | null = route.stage === "root" ? eventStage : route.stage;
  let mismatch: SchemaFailure | null = null;
  if (route.stage === "root" && !eventStage) {
    mismatch = {
      path: "header:x-ravn-event",
      keyword: "stage",
      message: "POST / needs x-ravn-event: stage.<stage>.requested naming a stage a hook can serve",
    };
  } else if (route.stage !== "root" && event !== null && eventStage !== route.stage) {
    mismatch = {
      path: "header:x-ravn-event",
      keyword: "stage",
      message: `x-ravn-event does not name the URL's stage (${route.stage})`,
    };
    stage = route.stage;
  }

  // 3. Validate against the public schema.
  let parsed: unknown;
  let parseError: string | null = null;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    parseError = "not JSON";
  }
  let schemaValid: boolean | null = null;
  let schemaFailures: SchemaFailure[] = [];
  const schema = deps.schema();
  if (parseError === null && stage !== null) {
    const verdict = schema.validateEnvelope(stage, parsed);
    schemaValid = verdict.valid;
    schemaFailures = verdict.failures;
  } else if (parseError === null) {
    schemaValid = false;
  }
  if (mismatch) {
    schemaFailures = [mismatch, ...schemaFailures];
  }

  // 4. The echo output: deterministic from inputDigest.
  const inputDigestRaw =
    parsed && typeof parsed === "object" ? (parsed as { inputDigest?: unknown }).inputDigest : null;
  const inputDigest =
    typeof inputDigestRaw === "string" && /^[0-9a-f]{64}$/.test(inputDigestRaw)
      ? inputDigestRaw
      : null;
  const seed = stage ? seedOf(body, inputDigest) : null;
  const echo = stage && seed ? echoOutput(stage, seed.digest, deps.version) : null;

  // 5. Respond per the mode. A request whose stage cannot be told is a 400 whatever the mode.
  const effectiveAttempt = attempt ?? seen;
  const decision =
    stage === null
      ? {
          status: 400,
          delayMs: 0,
          note: "no stage: the URL names none and x-ravn-event names none",
        }
      : decide(route.mode, effectiveAttempt);
  if (decision.delayMs > 0) await (deps.sleep ?? defaultSleep)(decision.delayMs);

  const record: DeliveryRecord = {
    seq: deps.store.nextSeq(),
    receivedAt: new Date(started).toISOString(),
    path,
    mode: describeMode(route.mode),
    stage,
    event,
    deliveryId,
    attempt,
    seen,
    duplicate,
    signatureValid: true,
    schemaValid,
    schemaFailures,
    parseError,
    inputDigest,
    seed,
    echo,
    response: { status: decision.status, note: decision.note },
    latencyMs: Math.max(0, (deps.now?.() ?? Date.now()) - started),
    shape: parseError === null ? shapeOf(parsed, schema.knownKeys) : null,
  };
  if (deps.showValues && parseError === null) record.body = parsed;
  deps.store.add(record);

  send(res, decision.status, {
    stage,
    deliveryId,
    attempt,
    duplicate,
    mode: record.mode,
    note: decision.note,
    schema: { valid: schemaValid, failures: schemaFailures },
    output: decision.status >= 200 && decision.status < 300 ? echo : null,
  });

  // 6. Answer as the service account, and read over MCP, after the response.
  if (deps.ravn && stage) {
    if (decision.status < 200 || decision.status >= 300) {
      record.answer = {
        plan: "now",
        state: "not-sent",
        reason: `the delivery was answered ${decision.status}: the run is answered once a delivery succeeds`,
      };
    } else if (schemaValid !== true || !echo) {
      record.answer = {
        plan: "now",
        state: "not-sent",
        reason: "the packet failed the schema, so it names no stage run to answer",
      };
    } else {
      deps.ravn.delivered({
        record,
        mode: route.mode,
        stage,
        envelope: parsed as Record<string, unknown>,
        echo,
      });
    }
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}
