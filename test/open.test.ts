import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { ravnUrls } from "../src/answers.js";
import { parseConfig } from "../src/config.js";
import { hashViewKey, OpenAnswerer, type OpenRecord, OpenStore } from "../src/open.js";
import { SCHEMA_ID } from "../src/schema.js";
import { createHookServer } from "../src/server.js";
import { HOOKABLE, type HookableStage, stageRequestedEvent } from "../src/stages.js";
import { DeliveryStore } from "../src/store.js";
import { FakeRavn } from "./fake-ravn.js";
import { CANARY, envelope } from "./fixtures.js";
import { schema } from "./helpers.js";

interface OpenHook {
  base: string;
  store: OpenStore;
  answerer: OpenAnswerer;
  close: () => Promise<void>;
}

async function openHook(fake: FakeRavn): Promise<OpenHook> {
  const store = new OpenStore();
  const answerer = new OpenAnswerer({
    answersUrl: ravnUrls(fake.base).answers,
    stages: new Set(HOOKABLE),
    schema: () => schema,
    store,
    sleep: async () => {},
  });
  const server = createHookServer({
    secret: null,
    viewToken: "",
    showValues: false,
    retentionHours: 24,
    version: "0.0.0-test",
    store: new DeliveryStore({ retentionHours: 24 }),
    schema: () => schema,
    schemaId: SCHEMA_ID,
    open: { answerer, store },
    sleep: async () => {},
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    answerer,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A view key as Ravn derives one: b64url of an HMAC, here just 32 random bytes. */
const newViewKey = () => randomBytes(32).toString("base64url");

let runs = 0;
let deliveries = 0;
function packet(stage: HookableStage, hookId: string) {
  return envelope(stage, {
    stageRunId: `${CANARY}-open-${++runs}-run-${stage}`,
    impl: { kind: "hook", hookId },
  });
}

async function post(
  base: string,
  path: string,
  body: Record<string, unknown>,
  headers: { token?: string | null; view?: string | null; stage?: HookableStage } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (headers.token) h["ravn-answer-token"] = headers.token;
  if (headers.view) h["ravn-echo-view"] = headers.view;
  if (headers.stage) h["x-ravn-event"] = stageRequestedEvent(headers.stage);
  h["x-ravn-delivery"] = `dlv-${++deliveries}`;
  h["x-ravn-attempt"] = "1";
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function view(base: string, key: string | null) {
  const res = await fetch(`${base}/api/deliveries`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

describe("open mode (ECHO_MODE=open)", () => {
  let fake: FakeRavn;
  let x: OpenHook;
  before(async () => {
    fake = new FakeRavn();
    await fake.start();
    x = await openHook(fake);
  });
  after(async () => {
    await x.close();
    await fake.close();
  });

  for (const stage of HOOKABLE) {
    test(`${stage}: answers with Ravn's token, and keeps it once Ravn accepts`, async () => {
      const hookId = `hook-${stage}`;
      const key = newViewKey();
      const p = packet(stage, hookId);
      const token = fake.newAnswerToken(p.stageRunId);
      const before = fake.answers.length;

      const r = await post(x.base, `/${stage}`, p, {
        token,
        view: hashViewKey(key),
        stage,
      });
      assert.equal(r.status, 200);
      await x.answerer.idle();

      const sent = fake.answers.slice(before);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.token, token, "posted as RavnAnswer <the delivery's token>");
      assert.equal(sent[0]?.code, "accepted");
      assert.equal(sent[0]?.body.stageRunId, p.stageRunId);

      const v = await view(x.base, key);
      assert.equal(v.status, 200);
      const list = v.json.deliveries as OpenRecord[];
      assert.equal(list.length, 1);
      assert.equal(list[0]?.hookId, hookId);
      assert.equal(list[0]?.stage, stage);
      assert.equal(list[0]?.answer?.code, "accepted");
      assert.equal(list[0]?.signatureValid, null);
      assert.ok(list[0]?.shape, "the packet's shape");
      assert.ok(!v.text.includes(CANARY), "shape only: no packet value reaches the viewer");
      assert.ok(!v.text.includes(token), "the answer token never reaches the viewer");
      assert.ok(!("viewHash" in (list[0] ?? {})), "the view hash is not handed back");
    });
  }

  test("a forged post: Ravn refuses its answer, and nothing is stored", async () => {
    const key = newViewKey();
    const p = packet("assess", "hook-forged");
    const before = fake.answers.length;
    const stored = x.store.all().length;

    // A token of the right shape that Ravn never minted.
    const forged = `${randomBytes(18).toString("base64url")}.${randomBytes(32).toString("base64url")}`;
    const r = await post(x.base, "/assess", p, {
      token: forged,
      view: hashViewKey(key),
      stage: "assess",
    });
    assert.equal(r.status, 200, "the post is answered as the mode says: echo cannot tell");
    await x.answerer.idle();

    const sent = fake.answers.slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.status, 401, "Ravn accepts no answer with a token it did not mint");
    assert.equal(x.store.all().length, stored, "nothing stored");
    assert.deepEqual((await view(x.base, key)).json.deliveries, []);
  });

  test("a real token for another stage run is refused too, and nothing is stored", async () => {
    const key = newViewKey();
    const victim = packet("route", "hook-victim");
    const mine = packet("route", "hook-attacker");
    const tokenForMine = fake.newAnswerToken(mine.stageRunId);
    const stored = x.store.all().length;
    await post(x.base, "/route", victim, {
      token: tokenForMine,
      view: hashViewKey(key),
      stage: "route",
    });
    await x.answerer.idle();
    assert.equal(x.store.all().length, stored);
  });

  test("a post without the token or the view hash is refused before anything is answered", async () => {
    const before = fake.answers.length;
    const p = packet("classify", "hook-noheaders");
    const token = fake.newAnswerToken(p.stageRunId);
    const view_ = hashViewKey(newViewKey());
    for (const h of [{}, { token }, { view: view_ }, { token: "not a token", view: view_ }]) {
      const r = await post(x.base, "/classify", p, { ...h, stage: "classify" });
      assert.equal(r.status, 401);
    }
    // A signature is no substitute: open mode has no secret.
    await x.answerer.idle();
    assert.equal(fake.answers.length, before, "nothing posted to Ravn");
  });

  test("a wrong viewer key gets nothing back, the same as a key with nothing yet", async () => {
    const key = newViewKey();
    const p = packet("knowledge", "hook-wrongkey");
    await post(x.base, "/knowledge", p, {
      token: fake.newAnswerToken(p.stageRunId),
      view: hashViewKey(key),
      stage: "knowledge",
    });
    await x.answerer.idle();
    assert.equal(((await view(x.base, key)).json.deliveries as unknown[]).length, 1);

    const wrong = await view(x.base, newViewKey());
    assert.equal(wrong.status, 200);
    assert.deepEqual(wrong.json.deliveries, []);
    // Presenting the hash Ravn sends, instead of the key, is a wrong key too.
    assert.deepEqual((await view(x.base, hashViewKey(key))).json.deliveries, []);
    assert.equal((await view(x.base, null)).status, 401);
  });

  test("another hook's key does not see this hook's deliveries", async () => {
    const keyA = newViewKey();
    const keyB = newViewKey();
    for (const [hookId, key] of [
      ["hook-a", keyA],
      ["hook-b", keyB],
    ] as const) {
      const p = packet("review", hookId);
      await post(x.base, "/review", p, {
        token: fake.newAnswerToken(p.stageRunId),
        view: hashViewKey(key),
        stage: "review",
      });
    }
    await x.answerer.idle();
    const a = (await view(x.base, keyA)).json.deliveries as OpenRecord[];
    const b = (await view(x.base, keyB)).json.deliveries as OpenRecord[];
    assert.deepEqual(
      a.map((r) => r.hookId),
      ["hook-a"],
    );
    assert.deepEqual(
      b.map((r) => r.hookId),
      ["hook-b"],
    );
  });

  test("never mode answers nothing, so nothing is stored", async () => {
    const key = newViewKey();
    const p = packet("assess", "hook-never");
    const before = fake.answers.length;
    const r = await post(x.base, "/assess/never", p, {
      token: fake.newAnswerToken(p.stageRunId),
      view: hashViewKey(key),
      stage: "assess",
    });
    assert.equal(r.status, 200);
    await x.answerer.idle();
    assert.equal(fake.answers.length, before);
    assert.deepEqual((await view(x.base, key)).json.deliveries, []);
  });

  test("a failing delivery is not answered until one succeeds", async () => {
    const key = newViewKey();
    const p = packet("assess", "hook-fail");
    const token = fake.newAnswerToken(p.stageRunId);
    const before = fake.answers.length;
    const r = await post(x.base, "/assess/fail/always", p, {
      token,
      view: hashViewKey(key),
      stage: "assess",
    });
    assert.equal(r.status, 500);
    await x.answerer.idle();
    assert.equal(fake.answers.length, before);
  });

  test("healthz says open, and configured", async () => {
    const res = await fetch(`${x.base}/healthz`);
    assert.deepEqual(await res.json(), { ok: true, mode: "open", configured: true });
  });
});

describe("OpenStore", () => {
  const rec = (hookId: string, viewHash: string, at: number): OpenRecord => ({
    seq: 0,
    receivedAt: new Date(at).toISOString(),
    path: "/assess",
    mode: "ok",
    stage: "assess",
    event: null,
    deliveryId: null,
    attempt: 1,
    seen: 1,
    duplicate: false,
    signatureValid: null,
    schemaValid: true,
    schemaFailures: [],
    parseError: null,
    inputDigest: null,
    seed: null,
    echo: null,
    response: { status: 200, note: "ok" },
    latencyMs: 0,
    shape: null,
    hookId,
    viewHash,
    storedAt: at,
  });

  test("keeps the last 50 per hook, newest first", () => {
    const s = new OpenStore();
    const t0 = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 60; i++) s.add({ ...rec("h", "v", t0 + i), seq: s.nextSeq() }, t0 + i);
    s.add({ ...rec("other", "w", t0), seq: s.nextSeq() }, t0 + 60);
    const list = s.list("v", t0 + 61);
    assert.equal(list.length, 50);
    assert.equal(list[0]?.seq, 60);
    assert.equal(list[49]?.seq, 11);
    assert.equal(s.list("w", t0 + 61).length, 1);
  });

  test("gone after 24 hours", () => {
    const s = new OpenStore();
    const t0 = Date.UTC(2026, 0, 1);
    s.add({ ...rec("h", "v", t0), seq: s.nextSeq() }, t0);
    assert.equal(s.list("v", t0 + 23 * 3_600_000).length, 1);
    assert.equal(s.list("v", t0 + 24 * 3_600_000 + 1).length, 0);
    assert.equal(s.all(t0 + 24 * 3_600_000 + 1).length, 0);
  });

  test("a hook whose key changed: the old key's entries are not shown to the new key", () => {
    const s = new OpenStore();
    const t0 = Date.UTC(2026, 0, 1);
    s.add({ ...rec("h", "old", t0), seq: s.nextSeq() }, t0);
    s.add({ ...rec("h", "new", t0 + 1), seq: s.nextSeq() }, t0 + 1);
    assert.equal(s.list("new", t0 + 2).length, 1);
    assert.equal(s.list("old", t0 + 2).length, 1);
  });

  test("the number of hooks is capped, least recently written dropped first", () => {
    const s = new OpenStore({ maxHooks: 2 });
    const t0 = Date.UTC(2026, 0, 1);
    for (const h of ["a", "b", "c"]) s.add({ ...rec(h, h, t0), seq: s.nextSeq() }, t0);
    assert.equal(s.list("a", t0).length, 0);
    assert.equal(s.list("c", t0).length, 1);
  });
});

describe("open mode config", () => {
  test("ECHO_MODE=open needs nothing", () => {
    const c = parseConfig([], { ECHO_MODE: "open" });
    assert.ok(c !== "help");
    assert.equal(c.echoMode, "open");
  });

  test("the default is signed, as before", () => {
    const c = parseConfig([], { RAVN_HOOK_SECRET: "s" });
    assert.ok(c !== "help");
    assert.equal(c.echoMode, "signed");
  });

  test("open mode refuses any org's credential", () => {
    for (const name of [
      "RAVN_HOOK_SECRET",
      "RAVN_UNWRAP_TOKEN",
      "RAVN_ACCESS_TOKEN_ONLY",
      "VIEW_TOKEN",
    ]) {
      assert.throws(() => parseConfig([], { ECHO_MODE: "open", [name]: "x" }), /takes no/);
    }
  });

  test("open mode keeps 24 hours at most", () => {
    assert.throws(() => parseConfig([], { ECHO_MODE: "open", RETENTION_HOURS: "48" }));
  });

  test("an unknown ECHO_MODE is refused", () => {
    assert.throws(() => parseConfig([], { ECHO_MODE: "public" }), /ECHO_MODE/);
  });
});
