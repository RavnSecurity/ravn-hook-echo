import assert from "node:assert/strict";
import { test } from "node:test";
import { CANARY, envelope } from "./fixtures.js";
import { deliver, schema, start } from "./helpers.js";

/**
 * AssessIn.precedents carries Precedent objects (ravn-platform#739), not
 * `{ id }`. A packet with the new shape validates; one with the old does not.
 */
const precedent = {
  id: `${CANARY}-precedent`,
  entryNo: 3,
  reportId: `${CANARY}-precedent-report`,
  externalRef: `${CANARY}-precedent-ref`,
  claim: {
    title: { value: `${CANARY}-precedent-title` },
    weakness: { value: { cwe: "CWE-79", label: `${CANARY}-xss` } },
  },
  decision: "ACCEPTED",
  ravnSaid: { value: { action: "escalate", ref: "rule.example" } },
  why: { value: null, reason: "not-configured" },
  whySource: "notes",
  decidedAt: "2026-01-02T03:04:05.000Z",
  decidedIn: `${CANARY}-precedent-run`,
};

function assessWith(precedents: unknown) {
  const base = envelope("assess");
  return { ...base, packet: { ...base.packet, precedents } };
}

test("an Assess packet with Precedent objects validates", () => {
  const verdict = schema.validateEnvelope("assess", assessWith({ value: [precedent] }));
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.valid, true);
});

test("the old { id } precedent shape no longer validates", () => {
  const verdict = schema.validateEnvelope("assess", assessWith({ value: [{ id: "p-1" }] }));
  assert.equal(verdict.valid, false);
});

test("POST /assess with the new precedents: 200, schema valid, shape shows no value", async () => {
  const h = await start();
  try {
    const r = await deliver(h.base, "/assess", assessWith({ value: [precedent] }), {
      stage: "assess",
      deliveryId: "d-precedents",
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.schema, { valid: true, failures: [] });
    const rec = h.store.list().find((d) => d.deliveryId === "d-precedents");
    assert.ok(rec?.shape);
    assert.equal(JSON.stringify(rec.shape).includes(CANARY), false);
  } finally {
    await h.close();
  }
});
