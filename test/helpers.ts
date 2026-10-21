import type { AddressInfo } from "node:net";
import type { Ravn } from "../src/answers.js";
import { loadVendoredSchema, SCHEMA_ID, StageSchema } from "../src/schema.js";
import { createHookServer } from "../src/server.js";
import { signBody } from "../src/signature.js";
import { type HookableStage, stageRequestedEvent } from "../src/stages.js";
import { DeliveryStore } from "../src/store.js";

export const SECRET = "test-signing-secret";
export const TOKEN = "0123456789abcdef0123456789abcdef";

export const schema = new StageSchema(loadVendoredSchema(), { kind: "vendored" });

export interface Running {
  base: string;
  store: DeliveryStore;
  sleeps: number[];
  close: () => Promise<void>;
}

export async function start(opts: { showValues?: boolean; ravn?: Ravn } = {}): Promise<Running> {
  const store = new DeliveryStore({ retentionHours: 24 });
  const sleeps: number[] = [];
  const server = createHookServer({
    secret: SECRET,
    viewToken: TOKEN,
    showValues: opts.showValues ?? false,
    retentionHours: 24,
    version: "0.0.0-test",
    store,
    schema: () => schema,
    schemaId: SCHEMA_ID,
    ...(opts.ravn ? { ravn: opts.ravn } : {}),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    sleeps,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export async function deliver(
  base: string,
  path: string,
  body: unknown,
  opts: {
    stage?: HookableStage;
    deliveryId?: string;
    attempt?: number;
    secret?: string | null;
    event?: string | null;
    raw?: string;
  } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const text = opts.raw ?? JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.secret !== null) headers["x-ravn-signature"] = signBody(text, opts.secret ?? SECRET);
  const event =
    opts.event === undefined ? (opts.stage ? stageRequestedEvent(opts.stage) : null) : opts.event;
  if (event) headers["x-ravn-event"] = event;
  if (opts.deliveryId) headers["x-ravn-delivery"] = opts.deliveryId;
  if (opts.attempt !== undefined) headers["x-ravn-attempt"] = String(opts.attempt);
  const res = await fetch(`${base}${path}`, { method: "POST", headers, body: text });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
