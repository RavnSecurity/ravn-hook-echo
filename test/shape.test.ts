import assert from "node:assert/strict";
import { test } from "node:test";
import { shapeOf } from "../src/shape.js";

const known = new Set(["title", "handle", "a", "b", "c", "d", "e", "f", "g", "value", "reason"]);

test("a Maybe shows its type or its empty reason, never its value", () => {
  assert.deepEqual(
    shapeOf({ title: { value: "secret" }, handle: { value: null, reason: "not-observed" } }, known),
    { handle: "absent · not-observed", title: "string · redacted" },
  );
});

test("nested objects and arrays keep their shape", () => {
  assert.deepEqual(
    shapeOf(
      { a: [{ b: 1 }, { b: 2 }], c: [], d: ["x", "y"], e: null, f: { value: { g: true } } },
      known,
    ),
    {
      a: { "array[2]": { b: "number · redacted" } },
      c: "array[0]",
      d: "array[2] · string",
      e: "null",
      f: { value: { g: "boolean · redacted" } },
    },
  );
});

test("a key the schema does not declare is redacted, numbered within its object", () => {
  assert.deepEqual(shapeOf({ title: 1, "q.secret": { p: 0.5 }, zzz: true }, new Set(["title"])), {
    "<key 1>": { "<key 1>": "number · redacted" },
    title: "number · redacted",
    "<key 2>": "boolean · redacted",
  });
});
