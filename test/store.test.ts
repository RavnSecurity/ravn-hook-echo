import assert from "node:assert/strict";
import { test } from "node:test";
import { type DeliveryRecord, DeliveryStore } from "../src/store.js";

const rec = (seq: number, at: number, deliveryId = "d"): DeliveryRecord => ({
  seq,
  receivedAt: new Date(at).toISOString(),
  path: "/assess",
  mode: "ok",
  stage: "assess",
  event: null,
  deliveryId,
  attempt: 1,
  seen: 1,
  duplicate: false,
  signatureValid: true,
  schemaValid: true,
  schemaFailures: [],
  parseError: null,
  inputDigest: null,
  seed: null,
  echo: null,
  response: { status: 200, note: "ok" },
  latencyMs: 0,
  shape: null,
});

test("deliveries are gone after RETENTION_HOURS", () => {
  const s = new DeliveryStore({ retentionHours: 1 });
  const t0 = Date.UTC(2026, 0, 1);
  s.add(rec(1, t0), t0);
  assert.equal(s.list(t0 + 59 * 60_000).length, 1);
  assert.equal(s.list(t0 + 61 * 60_000).length, 0);
});

test("the store is capped", () => {
  const s = new DeliveryStore({ retentionHours: 24, max: 3 });
  const t0 = Date.now();
  for (let i = 1; i <= 5; i++) s.add(rec(i, t0), t0);
  assert.deepEqual(
    s.list(t0).map((r) => r.seq),
    [5, 4, 3],
  );
});
