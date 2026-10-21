import assert from "node:assert/strict";
import { test } from "node:test";
import { signBody, verifySignature } from "../src/signature.js";

const body = Buffer.from('{"a":1}', "utf8");

test("a signature over the raw body verifies", () => {
  assert.equal(verifySignature(body, signBody(body, "s"), "s"), true);
});

test("upper-case hex verifies too", () => {
  const sig = signBody(body, "s")
    .replace(/^sha256=/, "sha256=")
    .toUpperCase()
    .replace("SHA256=", "sha256=");
  assert.equal(verifySignature(body, sig, "s"), true);
});

test("the wrong secret, a changed body, a missing header, another scheme or a short digest fail", () => {
  assert.equal(verifySignature(body, signBody(body, "other"), "s"), false);
  assert.equal(verifySignature(Buffer.from('{"a":2}'), signBody(body, "s"), "s"), false);
  assert.equal(verifySignature(body, undefined, "s"), false);
  assert.equal(verifySignature(body, signBody(body, "s").replace("sha256", "sha1"), "s"), false);
  assert.equal(verifySignature(body, "sha256=abc", "s"), false);
  assert.equal(verifySignature(body, "garbage", "s"), false);
  assert.equal(verifySignature(body, signBody(body, ""), ""), false);
});
