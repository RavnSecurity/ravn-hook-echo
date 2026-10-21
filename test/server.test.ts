import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { HOOKABLE } from "../src/stages.js";
import { envelope } from "./fixtures.js";
import { deliver, type Running, start, TOKEN } from "./helpers.js";

describe("receive", () => {
  let h: Running;
  before(async () => {
    h = await start();
  });
  after(() => h.close());

  test("unsigned and badly signed deliveries get 401 and nothing is stored", async () => {
    const before = h.store.list().length;
    const a = await deliver(h.base, "/assess", envelope("assess"), {
      stage: "assess",
      secret: null,
    });
    const b = await deliver(h.base, "/assess", envelope("assess"), {
      stage: "assess",
      secret: "wrong",
    });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(h.store.list().length, before);
  });

  for (const stage of HOOKABLE) {
    test(`POST /${stage}: 200 with a valid packet and its echo output`, async () => {
      const r = await deliver(h.base, `/${stage}`, envelope(stage), {
        stage,
        deliveryId: `d-${stage}`,
        attempt: 1,
      });
      assert.equal(r.status, 200);
      assert.equal(r.json.stage, stage);
      assert.deepEqual(r.json.schema, { valid: true, failures: [] });
      assert.ok(r.json.output && typeof r.json.output === "object");
    });
  }

  test("POST / dispatches on x-ravn-event", async () => {
    const r = await deliver(h.base, "/", envelope("route"), {
      stage: "route",
      deliveryId: "d-root",
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.stage, "route");
  });

  test("POST / with no stage event is a 400", async () => {
    const r = await deliver(h.base, "/", envelope("route"), { event: "report.decided" });
    assert.equal(r.status, 400);
  });

  test("the same input gets the same output", async () => {
    const a = await deliver(h.base, "/classify", envelope("classify"), { stage: "classify" });
    const b = await deliver(h.base, "/classify", envelope("classify"), { stage: "classify" });
    assert.deepEqual(a.json.output, b.json.output);
  });

  test("a retry is recognised by x-ravn-delivery", async () => {
    await deliver(h.base, "/knowledge", envelope("knowledge"), {
      stage: "knowledge",
      deliveryId: "d-retry",
      attempt: 1,
    });
    const r = await deliver(h.base, "/knowledge", envelope("knowledge"), {
      stage: "knowledge",
      deliveryId: "d-retry",
      attempt: 2,
    });
    assert.equal(r.json.duplicate, true);
    const rec = h.store.list().find((x) => x.deliveryId === "d-retry");
    assert.equal(rec?.seen, 2);
    assert.equal(rec?.attempt, 2);
  });

  test("an invalid packet is reported by JSON path, never by value", async () => {
    const bad = envelope("assess", { contract: 2, extraKey: "CANARY7f3a-extra" });
    (bad.packet as Record<string, unknown>) = { ...bad.packet, route: "CANARY7f3a-not-a-maybe" };
    const r = await deliver(h.base, "/assess", bad, { stage: "assess" });
    assert.equal(r.status, 200);
    const schema = r.json.schema as { valid: boolean; failures: { path: string }[] };
    assert.equal(schema.valid, false);
    const paths = schema.failures.map((f) => f.path);
    assert.ok(paths.includes("/contract"), paths.join(", "));
    assert.ok(paths.includes("/packet/route"), paths.join(", "));
    assert.ok(!JSON.stringify(schema).includes("CANARY"), "no value in the failures");
  });

  test("a body that is not JSON is stored as such and still answered", async () => {
    const r = await deliver(h.base, "/review", null, { stage: "review", raw: "not json" });
    assert.equal(r.status, 200);
    assert.equal((r.json.schema as { valid: unknown }).valid, null);
  });

  test("a URL and an x-ravn-event that disagree are flagged", async () => {
    const r = await deliver(h.base, "/assess", envelope("assess"), { stage: "route" });
    const schema = r.json.schema as { failures: { path: string }[] };
    assert.equal(schema.failures[0]?.path, "header:x-ravn-event");
  });

  test("GET on a hook URL is 405, an unknown path is 404", async () => {
    assert.equal((await fetch(`${h.base}/assess`)).status, 405);
    assert.equal((await fetch(`${h.base}/intake`, { method: "POST" })).status, 404);
  });
});

describe("modes", () => {
  let h: Running;
  before(async () => {
    h = await start();
  });
  after(() => h.close());

  test("fail/3: 500 for attempts 1–3, then 200", async () => {
    const statuses: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      const r = await deliver(h.base, "/assess/fail/3", envelope("assess"), {
        stage: "assess",
        deliveryId: "d-fail3",
        attempt,
      });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses, [500, 500, 500, 200]);
  });

  test("fail/<n> without x-ravn-attempt counts the deliveries it has seen", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await deliver(h.base, "/route/fail/2", envelope("route"), {
        stage: "route",
        deliveryId: "d-fail2-noattempt",
      });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses, [500, 500, 200]);
  });

  test("fail/always: 500 forever, still stored", async () => {
    const r = await deliver(h.base, "/assess/fail/always", envelope("assess"), {
      stage: "assess",
      attempt: 19,
    });
    assert.equal(r.status, 500);
    assert.equal(h.store.list()[0]?.response.status, 500);
  });

  test("slow/30s waits 30s, then 200; slow is capped at 120s", async () => {
    const a = await deliver(h.base, "/assess/slow/30s", envelope("assess"), { stage: "assess" });
    const b = await deliver(h.base, "/assess/slow/900s", envelope("assess"), { stage: "assess" });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(h.sleeps.slice(-2), [30_000, 120_000]);
  });

  test("status/<code> answers that code", async () => {
    for (const code of [202, 301, 410, 429, 503]) {
      const r = await deliver(h.base, `/assess/status/${code}`, envelope("assess"), {
        stage: "assess",
      });
      assert.equal(r.status, code);
    }
  });
});

describe("viewer API", () => {
  let h: Running;
  before(async () => {
    h = await start();
  });
  after(() => h.close());

  test("needs the bearer token", async () => {
    assert.equal((await fetch(`${h.base}/api/deliveries`)).status, 401);
    const wrong = await fetch(`${h.base}/api/deliveries`, {
      headers: { authorization: "Bearer nope" },
    });
    assert.equal(wrong.status, 401);
    const ok = await fetch(`${h.base}/api/deliveries`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(ok.status, 200);
  });

  test("shows what the issue lists for each delivery", async () => {
    await deliver(h.base, "/classify", envelope("classify"), {
      stage: "classify",
      deliveryId: "d-view",
      attempt: 1,
    });
    const res = await fetch(`${h.base}/api/deliveries`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const data = (await res.json()) as { deliveries: Record<string, unknown>[] };
    const d = data.deliveries[0] as Record<string, unknown>;
    for (const key of [
      "stage",
      "event",
      "deliveryId",
      "attempt",
      "receivedAt",
      "signatureValid",
      "schemaValid",
      "schemaFailures",
      "inputDigest",
      "echo",
      "response",
      "latencyMs",
      "shape",
    ]) {
      assert.ok(key in d, key);
    }
    assert.match(String(d.receivedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal("body" in d, false);
    const shape = d.shape as { packet: { report: { title: string; account: unknown } } };
    assert.equal(shape.packet.report.title, "string · redacted");
  });
});
