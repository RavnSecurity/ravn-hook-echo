import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { HOOKABLE } from "../src/stages.js";
import { CANARY, envelope } from "./fixtures.js";
import { deliver, type Running, start, TOKEN } from "./helpers.js";

/**
 * ❗THE VIEWER CANNOT LEAK. Every fixture packet carries canary strings in its
 * values. With --show-values off, no viewer response may contain one: not the
 * page, its script or stylesheet, and not the deliveries API, whatever the
 * delivery's mode, validity or retry state.
 */
let h: Running;
before(async () => {
  h = await start({ showValues: false });
  for (const stage of HOOKABLE) {
    await deliver(h.base, `/${stage}`, envelope(stage), {
      stage,
      deliveryId: `nv-${stage}`,
      attempt: 1,
    });
    await deliver(h.base, `/${stage}`, envelope(stage), {
      stage,
      deliveryId: `nv-${stage}`,
      attempt: 2,
    });
    await deliver(h.base, `/${stage}/fail/always`, envelope(stage), { stage, attempt: 1 });
    await deliver(h.base, `/${stage}/status/410`, envelope(stage), { stage });
    // Invalid: the canary sits where the schema fails, so a failure message
    // that quoted a value would leak it.
    const bad = envelope(stage, { contract: `${CANARY}-contract`, [`${CANARY}-key`]: 1 });
    await deliver(h.base, `/${stage}`, { ...bad, stage: `${CANARY}-stage` }, { stage });
    // A free-form map (Answers) keyed by canaries.
    const answers = { [`${CANARY}-question`]: { p: 0.5 } };
    const odd = envelope(stage, {
      packet: { ...envelope(stage).packet, answers: { value: answers } },
    });
    await deliver(h.base, `/${stage}`, odd, { stage });
  }
  await deliver(h.base, "/", envelope("assess"), { stage: "assess" });
  await deliver(h.base, "/assess", null, { stage: "assess", raw: `{"x":"${CANARY}-raw"` });
});
after(() => h.close());

const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

test("the fixtures really do carry canaries, and were stored", () => {
  assert.ok(JSON.stringify(envelope("assess")).includes(CANARY));
  assert.ok(h.store.list().length >= HOOKABLE.length * 5);
});

for (const path of ["/view", "/view.js", "/view.css", "/api/deliveries", "/view/api/deliveries"]) {
  test(`GET ${path} contains no value from a fixture packet`, async () => {
    const res = await fetch(`${h.base}${path}`, auth);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.length > 0);
    assert.equal(text.includes(CANARY), false, `${path} leaked a canary`);
  });
}

test("a canary used as a KEY does not show either: undeclared keys are redacted", async () => {
  const text = await (await fetch(`${h.base}/api/deliveries`, auth)).text();
  assert.equal(text.includes(`${CANARY}-key`), false);
  assert.match(text, /<key 1>/);
});

test("every viewer response carries the privacy headers", async () => {
  for (const path of ["/view", "/view.js", "/view.css", "/api/deliveries"]) {
    for (const init of [auth, {}]) {
      const res = await fetch(`${h.base}${path}`, init);
      assert.equal(res.headers.get("referrer-policy"), "no-referrer", path);
      assert.match(res.headers.get("x-robots-tag") ?? "", /noindex/, path);
      assert.equal(res.headers.get("cache-control"), "no-store", path);
      const csp = res.headers.get("content-security-policy") ?? "";
      assert.match(csp, /default-src 'none'/, path);
      assert.equal(/https?:/.test(csp), false, `${path}: no third-party origin in the CSP`);
    }
  }
});

test("the page has no OG tags and loads nothing from another origin", async () => {
  const html = await (await fetch(`${h.base}/view`)).text();
  assert.equal(/property=["']og:/i.test(html), false);
  assert.equal(/(src|href)=["']https?:/i.test(html), false);
});

test("with --show-values the same API does show values (the test can tell)", async () => {
  const shown = await start({ showValues: true });
  try {
    await deliver(shown.base, "/assess", envelope("assess"), { stage: "assess" });
    const text = await (await fetch(`${shown.base}/api/deliveries`, auth)).text();
    assert.equal(text.includes(CANARY), true);
  } finally {
    await shown.close();
  }
});
