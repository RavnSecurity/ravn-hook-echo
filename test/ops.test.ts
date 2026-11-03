import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { ServiceAccount } from "../src/account.js";
import { Ravn, ravnUrls } from "../src/answers.js";
import { McpReader } from "../src/mcp.js";
import { hashViewKey, OpenAnswerer, OpenStore } from "../src/open.js";
import { codeOf, idOf, Ops } from "../src/ops.js";
import { SCHEMA_ID } from "../src/schema.js";
import { createHookServer } from "../src/server.js";
import { HOOKABLE, type HookableStage, stageRequestedEvent } from "../src/stages.js";
import { DeliveryStore } from "../src/store.js";
import { FakeRavn, SECRET_MARK } from "./fake-ravn.js";
import { CANARY, envelope } from "./fixtures.js";
import { deliver, type Running, SECRET, schema, start, TOKEN } from "./helpers.js";

/**
 * ❗THE LOG CANNOT LEAK. Every fixture packet carries canaries in its values,
 * and every credential FakeRavn mints carries SECRET_MARK. Whatever reaches
 * stdout through Ops must carry none of them, nor the signing secret, the
 * view token, an answer token, a view key or its hash.
 *
 * The ids are plain here (`run-…`, `dlv-…`): ids are what the log is for.
 */

interface Captured {
  ops: Ops;
  lines: string[];
  events: () => Record<string, unknown>[];
}

function capture(): Captured {
  const lines: string[] = [];
  const ops = new Ops({ write: (l) => lines.push(l) });
  return {
    ops,
    lines,
    events: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

const plain = (stage: HookableStage, tag: string) =>
  envelope(stage, { stageRunId: `${tag}-run-${stage}`, impl: { kind: "hook", hookId: "hk-1" } });

function assertClean(text: string, extra: string[] = []): void {
  for (const s of [CANARY, SECRET_MARK, SECRET, TOKEN, ...extra]) {
    assert.equal(text.includes(s), false, `stdout carried ${s}`);
  }
}

async function scrape(base: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/metrics`, { headers });
  return { status: res.status, text: await res.text(), type: res.headers.get("content-type") };
}

describe("signed mode: a line per delivery and answer, and /metrics", () => {
  let fake: FakeRavn;
  let h: Running;
  let ravn: Ravn;
  const c = capture();
  before(async () => {
    fake = new FakeRavn();
    await fake.start();
    const urls = ravnUrls(fake.base);
    const account = new ServiceAccount({
      gatewayUrl: urls.gateway,
      unwrapToken: fake.newUnwrapToken(),
      stateFile: join(mkdtempSync(join(tmpdir(), "echo-state-")), "state.json"),
      log: () => {},
    });
    await account.start();
    ravn = new Ravn({
      account,
      reader: new McpReader({ url: urls.mcp, caller: account, version: "0.0.0-test" }),
      answersUrl: urls.answers,
      stages: new Set(HOOKABLE),
      schema: () => schema,
      sleep: async () => {},
      ops: c.ops,
    });
    h = await start({ ravn, ops: c.ops });

    for (const stage of HOOKABLE) {
      await deliver(h.base, `/${stage}`, plain(stage, "s"), {
        stage,
        deliveryId: `dlv-s-${stage}`,
        attempt: 1,
      });
    }
    // Refused: no signature. Mode-forced 500. Schema-invalid. A late answer.
    await deliver(h.base, "/assess", plain("assess", "nosig"), { stage: "assess", secret: null });
    await deliver(h.base, "/route/fail/always", plain("route", "f"), { stage: "route" });
    await deliver(
      h.base,
      "/review",
      { ...plain("review", "bad"), contract: `${CANARY}-c` },
      {
        stage: "review",
      },
    );
    fake.late.add("late-run-classify");
    await deliver(h.base, "/classify", plain("classify", "late"), { stage: "classify" });
    // An id that is not shaped like one is not logged.
    await deliver(h.base, "/assess", plain("assess", "odd"), {
      stage: "assess",
      deliveryId: `${CANARY} with spaces`,
    });
    await ravn.idle();
  });
  after(async () => {
    await h.close();
    await fake.close();
  });

  test("one delivery.received per POST, with stage, attempt, id, mode and outcome", () => {
    const got = c.events().filter((e) => e.event === "delivery.received");
    assert.equal(got.length, HOOKABLE.length + 5);
    const classify = got.find((e) => e.deliveryId === "dlv-s-classify");
    assert.ok(classify);
    assert.equal(classify.stage, "classify");
    assert.equal(classify.attempt, 1);
    assert.equal(classify.hookMode, "signed");
    assert.equal(classify.mode, "ok");
    assert.equal(classify.signature, true);
    assert.equal(classify.schemaOk, true);
    assert.equal(classify.outcome, "ok");
    assert.equal(classify.status, 200);
    assert.match(String(classify.at), /^\d{4}-\d\d-\d\dT/);

    const outcomes = got.map((e) => e.outcome);
    assert.ok(outcomes.includes("unauthorized"));
    assert.ok(outcomes.includes("mode_status"));
    assert.ok(outcomes.includes("schema_invalid"));
    const nosig = got.find((e) => e.outcome === "unauthorized");
    assert.equal(nosig?.signature, false);
    assert.equal(nosig?.schemaOk, null);
    assert.ok(got.some((e) => e.deliveryId === null && e.stage === "assess"));
  });

  test("one answer.sent per answer, with run id, attempt, Ravn's code and latency", () => {
    const got = c.events().filter((e) => e.event === "answer.sent");
    // Every stage once, the late one, the odd-id one; none for the 500 or the invalid.
    assert.equal(got.length, HOOKABLE.length + 2);
    const assess = got.find((e) => e.stageRunId === "s-run-assess");
    assert.ok(assess);
    assert.equal(assess.code, "accepted");
    assert.equal(assess.status, 200);
    assert.equal(assess.attempt, 1);
    assert.equal(typeof assess.latencyMs, "number");
    assert.equal(got.find((e) => e.stageRunId === "late-run-classify")?.code, "late");
  });

  test("/metrics counts the same deliveries and answers", async () => {
    const m = await scrape(h.base);
    assert.equal(m.status, 200);
    assert.match(m.type ?? "", /^text\/plain; version=0\.0\.4/);
    assert.match(m.text, /# TYPE echo_deliveries_total counter/);
    assert.match(m.text, /^echo_deliveries_total\{stage="assess",outcome="ok"\} 2$/m);
    assert.match(m.text, /^echo_deliveries_total\{stage="assess",outcome="unauthorized"\} 1$/m);
    assert.match(m.text, /^echo_deliveries_total\{stage="route",outcome="mode_status"\} 1$/m);
    assert.match(m.text, /^echo_answers_total\{stage="classify",code="late"\} 1$/m);
    assert.match(m.text, /^echo_answers_total\{stage="classify",code="accepted"\} 1$/m);
    assert.equal(c.ops.deliveries.get({ stage: "review", outcome: "schema_invalid" }), 1);
  });

  test("/metrics through a proxy (x-forwarded-for) is not found", async () => {
    assert.equal((await scrape(h.base, { "x-forwarded-for": "203.0.113.9" })).status, 404);
  });

  test("stdout carries no value, token or secret", async () => {
    assert.ok(c.lines.length > 0);
    assertClean(c.lines.join(""), [...fake.access]);
    assertClean((await scrape(h.base)).text);
  });
});

describe("open mode: a line per delivery and answer, and /metrics", () => {
  let fake: FakeRavn;
  let base: string;
  let close: () => Promise<void>;
  let answerer: OpenAnswerer;
  const c = capture();
  const key = "view-key-SECRETMARK9c1e-abcdefghijklmnop";
  const viewHash = hashViewKey(key);
  const tokens: string[] = [];
  before(async () => {
    fake = new FakeRavn();
    await fake.start();
    const store = new OpenStore();
    answerer = new OpenAnswerer({
      answersUrl: ravnUrls(fake.base).answers,
      stages: new Set(HOOKABLE),
      schema: () => schema,
      store,
      sleep: async () => {},
      ops: c.ops,
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
      ops: c.ops,
      sleep: async () => {},
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => server.close(() => r()));

    const post = (stage: HookableStage, body: unknown, token: string | null, id: string) =>
      fetch(`${base}/${stage}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ravn-event": stageRequestedEvent(stage),
          "x-ravn-delivery": id,
          "x-ravn-attempt": "1",
          ...(token ? { "ravn-answer-token": token, "ravn-echo-view": viewHash } : {}),
        },
        body: JSON.stringify(body),
      }).then((r) => r.text());

    for (const stage of HOOKABLE) {
      const t = fake.newAnswerToken(`o-run-${stage}`);
      tokens.push(t);
      await post(stage, plain(stage, "o"), t, `dlv-o-${stage}`);
    }
    // No token: refused, nothing answered.
    await post("assess", plain("assess", "forged"), null, "dlv-forged");
    // A token Ravn never minted: answered, and refused by Ravn.
    const fakeToken = `${"A".repeat(24)}.${"B".repeat(43)}`;
    tokens.push(fakeToken);
    await post("route", plain("route", "made-up"), fakeToken, "dlv-made-up");
    await answerer.idle();
  });
  after(async () => {
    await close();
    await fake.close();
  });

  test("deliveries and answers are logged, refusals included", () => {
    const got = c.events();
    const received = got.filter((e) => e.event === "delivery.received");
    const answered = got.filter((e) => e.event === "answer.sent");
    assert.equal(received.length, HOOKABLE.length + 2);
    assert.equal(answered.length, HOOKABLE.length + 1);

    const forged = received.find((e) => e.deliveryId === "dlv-forged");
    assert.equal(forged?.outcome, "unauthorized");
    assert.equal(forged?.token, false);
    assert.equal(forged?.hookMode, "open");
    const ok = received.find((e) => e.deliveryId === "dlv-o-knowledge");
    assert.equal(ok?.token, true);
    assert.equal(ok?.outcome, "ok");

    assert.equal(answered.find((e) => e.stageRunId === "o-run-classify")?.code, "accepted");
    const refused = answered.find((e) => e.stageRunId === "made-up-run-route");
    assert.equal(refused?.code, "unauthorized");
    assert.equal(refused?.status, 401);
  });

  test("/metrics counts them", async () => {
    const m = await scrape(base);
    assert.equal(m.status, 200);
    assert.match(m.text, /^echo_deliveries_total\{stage="assess",outcome="unauthorized"\} 1$/m);
    assert.match(m.text, /^echo_answers_total\{stage="route",code="unauthorized"\} 1$/m);
    assert.match(m.text, /^echo_answers_total\{stage="route",code="accepted"\} 1$/m);
  });

  test("stdout carries no value, answer token, view key or view hash", async () => {
    assertClean(c.lines.join(""), [...tokens, key, viewHash]);
    assertClean((await scrape(base)).text, [...tokens, key, viewHash]);
  });
});

test("without Ops, /metrics is not found", async () => {
  const h = await start();
  try {
    assert.equal((await scrape(h.base)).status, 404);
  } finally {
    await h.close();
  }
});

test("idOf and codeOf keep only what is shaped like an id or a code", () => {
  assert.equal(idOf("run_01J9-abc:2"), "run_01J9-abc:2");
  for (const bad of ["", "has space", "x".repeat(129), "-leading", "new\nline", 7, null]) {
    assert.equal(idOf(bad), null, String(bad));
  }
  assert.equal(codeOf("schema_invalid"), "schema_invalid");
  assert.equal(codeOf("http-502"), "http-502");
  for (const bad of ["Accepted", "a b", "x".repeat(41), '"}', undefined]) {
    assert.equal(codeOf(bad), "other", String(bad));
  }
});
