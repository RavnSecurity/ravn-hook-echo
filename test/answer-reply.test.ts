import assert from "node:assert/strict";
import { test } from "node:test";
import { readAnswerReply } from "../src/answers.js";

const BODY_MARK = "BODYMARK5d2b";

test("a reply that is not JSON: warns with status and content type only, then falls back", async () => {
  const lines: string[] = [];
  const res = new Response(`<html>${BODY_MARK} bad gateway</html>`, {
    status: 502,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  const reply = await readAnswerReply(res, (l) => lines.push(l));
  assert.deepEqual(reply, { status: 502, code: "http-502" });
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /502/);
  assert.match(lines[0] ?? "", /content-type: text\/html; charset=utf-8/);
  assert.equal(lines[0]?.includes(BODY_MARK), false, "the body is never logged");
});

test("no content type at all says none", async () => {
  const lines: string[] = [];
  const res = new Response(new Uint8Array([0xff, 0x00]), { status: 500 });
  res.headers.delete("content-type");
  await readAnswerReply(res, (l) => lines.push(l));
  assert.match(lines[0] ?? "", /content-type: none/);
});

test("a JSON reply: no warning, and its code is read", async () => {
  const lines: string[] = [];
  const res = Response.json({ answer: "accepted", replayed: true }, { status: 200 });
  const reply = await readAnswerReply(res, (l) => lines.push(l));
  assert.deepEqual(reply, { status: 200, code: "accepted", replayed: true });
  assert.deepEqual(lines, []);
});

test("JSON that is not an object falls back without throwing", async () => {
  const reply = await readAnswerReply(Response.json(null, { status: 500 }), () => {});
  assert.deepEqual(reply, { status: 500, code: "http-500" });
});
