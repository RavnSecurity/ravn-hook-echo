import assert from "node:assert/strict";
import { test } from "node:test";
import { echoOutput, seedOf } from "../src/echo.js";
import { HOOKABLE } from "../src/stages.js";
import { envelope } from "./fixtures.js";
import { schema } from "./helpers.js";

const digests = [
  "0".repeat(64),
  "f".repeat(64),
  "0123456789abcdef".repeat(4),
  "fedcba9876543210".repeat(4),
  ...Array.from({ length: 40 }, (_, i) =>
    Array.from({ length: 64 }, (_, j) => ((i * 7 + j * 13) % 16).toString(16)).join(""),
  ),
];

for (const stage of HOOKABLE) {
  test(`${stage}: the fixture envelope is valid against the public schema`, () => {
    const verdict = schema.validateEnvelope(stage, envelope(stage));
    assert.deepEqual(verdict.failures, []);
    assert.equal(verdict.valid, true);
  });

  test(`${stage}: every echo output is valid against the stage's output schema`, () => {
    for (const d of digests) {
      const out = echoOutput(stage, d, "1.2.3");
      const verdict = schema.validateOutput(stage, out);
      assert.deepEqual(verdict.failures, [], `digest ${d}`);
    }
  });

  test(`${stage}: the same digest always gives the same output, and a different one may not`, () => {
    const a = echoOutput(stage, digests[2] as string, "1.2.3");
    const b = echoOutput(stage, digests[2] as string, "1.2.3");
    assert.deepEqual(a, b);
    const outs = new Set(digests.map((d) => JSON.stringify(echoOutput(stage, d, "1.2.3"))));
    assert.ok(outs.size > 1, "the output depends on the digest");
  });
}

test("the seed is inputDigest when it is well formed, else the body's sha256", () => {
  const body = Buffer.from("{}");
  assert.deepEqual(seedOf(body, "a".repeat(64)), { kind: "inputDigest", digest: "a".repeat(64) });
  const fallback = seedOf(body, "not-a-digest");
  assert.equal(fallback.kind, "body-sha256");
  assert.match(fallback.digest, /^[0-9a-f]{64}$/);
});
