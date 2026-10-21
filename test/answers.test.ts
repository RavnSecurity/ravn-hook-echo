import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { ServiceAccount } from "../src/account.js";
import { answerOut, INVALID_KEY, Ravn, ravnUrls } from "../src/answers.js";
import { echoOutput } from "../src/echo.js";
import { McpReader } from "../src/mcp.js";
import { HOOKABLE, type HookableStage } from "../src/stages.js";
import type { DeliveryRecord } from "../src/store.js";
import { FakeRavn, SECRET_MARK } from "./fake-ravn.js";
import { CANARY, envelope } from "./fixtures.js";
import { deliver, type Running, schema, start, TOKEN } from "./helpers.js";

interface Hook {
  h: Running;
  ravn: Ravn;
  account: ServiceAccount;
  sleeps: number[];
  close: () => Promise<void>;
}

async function hook(fake: FakeRavn, stages: readonly HookableStage[] = HOOKABLE): Promise<Hook> {
  const urls = ravnUrls(fake.base);
  const account = new ServiceAccount({
    gatewayUrl: urls.gateway,
    unwrapToken: fake.newUnwrapToken(),
    stateFile: join(mkdtempSync(join(tmpdir(), "echo-state-")), "state.json"),
    log: () => {},
  });
  await account.start();
  const sleeps: number[] = [];
  const ravn = new Ravn({
    account,
    reader: new McpReader({ url: urls.mcp, caller: account, version: "0.0.0-test" }),
    answersUrl: urls.answers,
    stages: new Set(stages),
    schema: () => schema,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const h = await start({ ravn });
  return { h, ravn, account, sleeps, close: () => h.close() };
}

/** A packet for its own stage run, so tests do not see each other's runs as retries. */
const run = (stage: HookableStage, tag: string) =>
  envelope(stage, { stageRunId: `${CANARY}-${tag}-run-${stage}` });

const recordOf = (h: Running, stage: HookableStage, tag: string): DeliveryRecord => {
  const r = h.store.list().find((d) => d.deliveryId === `${tag}-${stage}`);
  assert.ok(r, `a record for ${tag}-${stage}`);
  return r;
};

describe("answers, as the service account", () => {
  let fake: FakeRavn;
  let x: Hook;
  before(async () => {
    fake = new FakeRavn();
    await fake.start();
    x = await hook(fake);
  });
  after(async () => {
    await x.close();
    await fake.close();
  });

  test("every stage is answered with its echo output, which Ravn accepts", async () => {
    for (const stage of HOOKABLE) {
      const r = await deliver(x.h.base, `/${stage}`, run(stage, "all"), {
        stage,
        deliveryId: `all-${stage}`,
      });
      assert.equal(r.status, 200);
    }
    await x.ravn.idle();
    for (const stage of HOOKABLE) {
      const call = fake.answers.find((a) => a.body.stageRunId === `${CANARY}-all-run-${stage}`);
      assert.ok(call, `${stage} was answered`);
      assert.equal(call.code, "accepted");
      assert.equal(call.body.attempt, 1);
      const echo = recordOf(x.h, stage, "all").echo;
      assert.deepEqual(call.body.out, stage === "follow-up" ? [echo] : echo);
      const rec = recordOf(x.h, stage, "all").answer;
      assert.equal(rec?.state, "sent");
      assert.equal(rec?.code, "accepted");
      assert.equal(rec?.localValid, true);
    }
  });

  test("a retried delivery of one stage run is answered once", async () => {
    const before = fake.answers.length;
    for (const attempt of [1, 2, 3]) {
      await deliver(x.h.base, "/assess", run("assess", "retry"), {
        stage: "assess",
        deliveryId: "retry-assess",
        attempt,
      });
    }
    await x.ravn.idle();
    assert.equal(fake.answers.length, before + 1);
    const records = x.h.store.list().filter((d) => d.deliveryId === "retry-assess");
    assert.equal(records.filter((d) => d.answer?.state === "sent").length, 1);
    assert.equal(records.filter((d) => /already answered/.test(d.answer?.reason ?? "")).length, 2);
  });

  test("fail/1: the failed attempt is not answered; the delivered one is", async () => {
    const before = fake.answers.length;
    for (const attempt of [1, 2]) {
      await deliver(x.h.base, "/route/fail/1", run("route", "fail"), {
        stage: "route",
        deliveryId: "fail-route",
        attempt,
      });
    }
    await x.ravn.idle();
    assert.equal(fake.answers.length, before + 1);
    const [second, first] = x.h.store.list().filter((d) => d.deliveryId === "fail-route");
    assert.match(first?.answer?.reason ?? "", /answered 500/);
    assert.equal(second?.answer?.code, "accepted");
  });

  test("/never receives and never answers", async () => {
    const before = fake.answers.length;
    await deliver(x.h.base, "/classify/never", run("classify", "never"), {
      stage: "classify",
      deliveryId: "never-classify",
    });
    await x.ravn.idle();
    assert.equal(fake.answers.length, before);
    const rec = recordOf(x.h, "classify", "never");
    assert.equal(rec.response.status, 200);
    assert.equal(rec.answer?.plan, "never");
    assert.equal(rec.answer?.state, "not-sent");
  });

  test("/answer-late/<d> waits, then answers; Ravn's `late` is shown", async () => {
    fake.late.add(`${CANARY}-late-run-assess`);
    await deliver(x.h.base, "/assess/answer-late/5m", run("assess", "late"), {
      stage: "assess",
      deliveryId: "late-assess",
    });
    await x.ravn.idle();
    assert.ok(x.sleeps.includes(300_000));
    const rec = recordOf(x.h, "assess", "late").answer;
    assert.equal(rec?.plan, "late 300000ms");
    assert.ok(rec?.dueAt);
    assert.equal(rec?.status, 409);
    assert.equal(rec?.code, "late");
  });

  test("/answer-invalid sends a schema-invalid Out; the refusal's paths are shown", async () => {
    for (const stage of HOOKABLE) {
      await deliver(x.h.base, `/${stage}/answer-invalid`, run(stage, "invalid"), {
        stage,
        deliveryId: `invalid-${stage}`,
      });
    }
    await x.ravn.idle();
    for (const stage of HOOKABLE) {
      const rec = recordOf(x.h, stage, "invalid").answer;
      assert.equal(rec?.localValid, false, `${stage}: invalid here too`);
      assert.equal(rec?.status, 422);
      assert.equal(rec?.code, "schema_invalid");
      assert.ok((rec?.paths ?? []).length > 0, `${stage}: paths`);
    }
  });

  test("ANSWER_STAGES leaves the others unanswered, and says why", async () => {
    const only = await hook(fake, ["route"]);
    try {
      const before = fake.answers.length;
      for (const stage of ["classify", "route"] as const) {
        await deliver(only.h.base, `/${stage}`, run(stage, "only"), {
          stage,
          deliveryId: `only-${stage}`,
        });
      }
      await only.ravn.idle();
      assert.equal(fake.answers.length, before + 1);
      assert.match(recordOf(only.h, "classify", "only").answer?.reason ?? "", /ANSWER_STAGES/);
      assert.equal(recordOf(only.h, "route", "only").answer?.code, "accepted");
    } finally {
      await only.close();
    }
  });

  test("a 401 from Ravn renews the access token and the answer goes through", async () => {
    fake.expireAccessTokens();
    const renews = fake.renews;
    await deliver(x.h.base, "/knowledge", run("knowledge", "401"), {
      stage: "knowledge",
      deliveryId: "401-knowledge",
    });
    await x.ravn.idle();
    assert.equal(fake.renews, renews + 1);
    assert.equal(recordOf(x.h, "knowledge", "401").answer?.code, "accepted");
  });

  test("each delivery is followed by the four MCP reads, with the same token, codes and counts kept", async () => {
    const rec = recordOf(x.h, "classify", "all");
    const reads = rec.reads ?? [];
    assert.deepEqual(
      reads.map((r) => [r.tool, r.code]),
      [
        ["get_case", "2-packets"],
        ["get_reporter_facts", "1-facts"],
        ["find_similar", "similar"],
        ["lookup_precedents", "not-kept"],
      ],
    );
    assert.deepEqual(reads[0]?.counts, { packets: 2 });
    assert.deepEqual(reads[1]?.counts, { facts: 1 });
    assert.deepEqual(reads[2]?.counts, { "similar.thisProgram": 1 });
    const calls = fake.mcp.filter((m) => m.method === "tools/call");
    assert.ok(calls.every((m) => fake.access.has(m.token) || m.token.startsWith("access-")));
    const facts = calls.find((m) => m.tool === "get_reporter_facts");
    assert.deepEqual((facts?.args as { reporter?: unknown }).reporter, {
      source: `${CANARY}-acct-source`,
      externalId: `${CANARY}-acct-id`,
    });
  });

  test("a later stage of the same case reads the reporter Classify named", async () => {
    const reads = recordOf(x.h, "assess", "all").reads ?? [];
    assert.equal(reads[1]?.code, "1-facts");
  });

  test("the viewer shows answers and reads, and no packet value, MCP value or token", async () => {
    const text = await (
      await fetch(`${x.h.base}/api/deliveries`, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).text();
    const data = JSON.parse(text) as { account: { state: string } };
    assert.equal(data.account.state, "ok");
    assert.match(text, /"code":"accepted"/);
    assert.match(text, /"code":"2-packets"/);
    assert.equal(text.includes(CANARY), false, "no canary: packet values and MCP values");
    assert.equal(text.includes(SECRET_MARK), false, "no token");
  });
});

test("every echo output, as an answer, is a valid <Stage>Answer; the invalid one is not", () => {
  for (const stage of HOOKABLE) {
    for (const digest of ["00".repeat(32), "ff".repeat(32), "5a".repeat(32)]) {
      const echo = echoOutput(stage, digest, "0.0.0-test");
      const ok = schema.validateAnswer(stage, {
        stageRunId: "r",
        attempt: 1,
        out: answerOut(stage, echo, false),
      });
      assert.deepEqual(ok, { valid: true, failures: [] }, `${stage} ${digest}`);
      const bad = answerOut(stage, echo, true);
      assert.equal(JSON.stringify(bad).includes(INVALID_KEY), true);
      assert.equal(
        schema.validateAnswer(stage, { stageRunId: "r", attempt: 1, out: bad }).valid,
        false,
      );
    }
  }
});
