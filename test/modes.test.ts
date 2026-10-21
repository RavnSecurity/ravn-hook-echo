import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, MAX_FAIL_ATTEMPTS, MAX_SLOW_MS, parseRoute } from "../src/modes.js";

test("routes parse", () => {
  assert.deepEqual(parseRoute("/assess"), { stage: "assess", mode: { kind: "ok" } });
  assert.deepEqual(parseRoute("/"), { stage: "root", mode: { kind: "ok" } });
  assert.deepEqual(parseRoute("/follow-up/fail/3"), {
    stage: "follow-up",
    mode: { kind: "fail", until: 3 },
  });
  assert.deepEqual(parseRoute("/route/fail/always"), {
    stage: "route",
    mode: { kind: "fail-always" },
  });
  assert.deepEqual(parseRoute("/assess/slow/30s"), {
    stage: "assess",
    mode: { kind: "slow", ms: 30_000 },
  });
  assert.deepEqual(parseRoute("/assess/slow/250ms"), {
    stage: "assess",
    mode: { kind: "slow", ms: 250 },
  });
  assert.deepEqual(parseRoute("/assess/status/410"), {
    stage: "assess",
    mode: { kind: "status", status: 410 },
  });
  assert.deepEqual(parseRoute("/fail/2"), { stage: "root", mode: { kind: "fail", until: 2 } });
});

test("the caps hold: fail at 20 attempts, slow at 120s", () => {
  assert.deepEqual(parseRoute("/assess/fail/999")?.mode, {
    kind: "fail",
    until: MAX_FAIL_ATTEMPTS,
  });
  assert.deepEqual(parseRoute("/assess/slow/600s")?.mode, { kind: "slow", ms: MAX_SLOW_MS });
  assert.equal(MAX_FAIL_ATTEMPTS, 20);
  assert.equal(MAX_SLOW_MS, 120_000);
});

test("not hook URLs", () => {
  for (const p of [
    "/intake",
    "/nope",
    "/assess/fail",
    "/assess/fail/0",
    "/assess/fail/x",
    "/assess/slow/5",
    "/assess/status/99",
    "/assess/status/600",
    "/assess/teapot/418",
    "/assess/fail/3/extra",
  ]) {
    assert.equal(parseRoute(p), null, p);
  }
});

test("fail/3 fails attempts 1 to 3 and delivers on 4", () => {
  const mode = { kind: "fail", until: 3 } as const;
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((a) => decide(mode, a).status),
    [500, 500, 500, 200, 200],
  );
});

test("fail/always never delivers; status/<code> answers the code; slow waits", () => {
  assert.equal(decide({ kind: "fail-always" }, 50).status, 500);
  assert.equal(decide({ kind: "status", status: 410 }, 1).status, 410);
  assert.deepEqual(
    [
      decide({ kind: "slow", ms: 30_000 }, 1).status,
      decide({ kind: "slow", ms: 30_000 }, 1).delayMs,
    ],
    [200, 30_000],
  );
});
