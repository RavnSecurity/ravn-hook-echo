import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ServiceAccount } from "../src/account.js";
import {
  interactive,
  type PromptIO,
  promptSetup,
  readHidden,
  secretQuestion,
  TOKEN_QUESTION,
  whatToAsk,
} from "../src/prompt.js";
import { SCHEMA_ID } from "../src/schema.js";
import { createHookServer, type ServerDeps } from "../src/server.js";
import { hasSavedRefreshToken, savedHookSecret, saveHookSecret } from "../src/state.js";
import { DeliveryStore } from "../src/store.js";
import { FakeRavn } from "./fake-ravn.js";
import { envelope } from "./fixtures.js";
import { deliver, SECRET, schema, TOKEN } from "./helpers.js";

/** A terminal that types the next scripted keystrokes each time it is read from. */
class FakeTTY extends EventEmitter {
  isTTY = true;
  raw: boolean[] = [];
  constructor(private readonly keys: string[]) {
    super();
  }
  setRawMode(mode: boolean) {
    this.raw.push(mode);
  }
  resume() {
    const next = this.keys.shift();
    if (next !== undefined) setImmediate(() => this.emit("data", Buffer.from(next)));
  }
  pause() {}
  get left() {
    return this.keys.length;
  }
}

function tty(keys: string[]): PromptIO & { input: FakeTTY; text: () => string } {
  let out = "";
  const input = new FakeTTY(keys);
  return {
    input,
    output: {
      isTTY: true,
      write: (t: string) => {
        out += t;
      },
    },
    text: () => out,
  };
}

const ADDRESS = "https://quiet-words.trycloudflare.com/";
const TOKEN_VALUE = "rvu_TOKENVALUE7";
const SECRET_VALUE = "SECRETVALUE7f3";

async function setup(keys: string[], ask = { token: true, secret: true }) {
  const io = tty(keys);
  const tokens: string[] = [];
  const secrets: string[] = [];
  const outcome = await promptSetup({
    io,
    ask,
    address: ADDRESS,
    onToken: async (t) => {
      tokens.push(t);
    },
    onSecret: (s) => {
      secrets.push(s);
    },
  });
  const text = io.text();
  assert.equal(text.includes("TOKENVALUE"), false, `the token was written:\n${text}`);
  assert.equal(text.includes("SECRETVALUE"), false, `the secret was written:\n${text}`);
  return { outcome, tokens, secrets, text, io };
}

test("token, then secret: both are handed over, in that order, and neither is written back", async () => {
  const r = await setup([`${TOKEN_VALUE}\r`, `${SECRET_VALUE}\r`]);
  assert.equal(r.outcome, "done");
  assert.deepEqual(r.tokens, [TOKEN_VALUE]);
  assert.deepEqual(r.secrets, [SECRET_VALUE]);
  assert.ok(r.text.indexOf(TOKEN_QUESTION) < r.text.indexOf(secretQuestion(ADDRESS)));
  assert.deepEqual(r.io.input.raw, [true, false, true, false], "raw mode on to read, off after");
});

test("Enter at the token prompt skips it: receive only, and the secret is still asked", async () => {
  const r = await setup(["\r", `${SECRET_VALUE}\r`]);
  assert.deepEqual(r.tokens, []);
  assert.deepEqual(r.secrets, [SECRET_VALUE]);
  assert.match(r.text, /skipped: receive only/);
});

test("an obviously wrong paste is refused with one line and asked again", async () => {
  const r = await setup([
    `${SECRET_VALUE}\r`, // the secret, into the token prompt
    "rvu_TOKENVALUE with space\r",
    `${TOKEN_VALUE}\r`,
    "\r", // empty secret
    "SECRETVALUE\twith tab\r",
    `${TOKEN_VALUE}\r`, // the token, into the secret prompt
    `${SECRET_VALUE}\r`,
  ]);
  assert.equal(r.outcome, "done");
  assert.deepEqual(r.tokens, [TOKEN_VALUE]);
  assert.deepEqual(r.secrets, [SECRET_VALUE]);
  assert.match(r.text, /not an unwrap token \(they start rvu_\)/);
  assert.match(r.text, /nothing was pasted/);
  assert.match(r.text, /that is the unwrap token, not the hook's signing secret/);
  assert.equal(r.text.match(/whitespace/g)?.length, 2);
  assert.equal(r.text.split(TOKEN_QUESTION).length - 1, 3);
  assert.equal(r.text.split(secretQuestion(ADDRESS)).length - 1, 4);
});

test("only what is asked for is asked", async () => {
  const r = await setup([`${SECRET_VALUE}\r`], { token: false, secret: true });
  assert.equal(r.text.includes(TOKEN_QUESTION), false);
  assert.deepEqual(r.secrets, [SECRET_VALUE]);
});

test("Ctrl-C at a prompt interrupts, and nothing is handed over", async () => {
  const r = await setup(["rvu_TOKENVA\u0003"]);
  assert.equal(r.outcome, "interrupted");
  assert.deepEqual(r.tokens, []);
  assert.deepEqual(r.secrets, []);
  assert.deepEqual(r.io.input.raw, [true, false]);
});

test("hidden input: backspace, Ctrl-U and a terminal's bracketed-paste markers", async () => {
  const read = (keys: string) => readHidden(tty([keys]), "?");
  assert.equal(await read("abcx\u007f\r"), "abc");
  assert.equal(await read("abcx\b\r"), "abc");
  assert.equal(await read("wrong\u0015right\r"), "right");
  assert.equal(await read("\u001b[200~pasted\u001b[201~\r"), "pasted");
  assert.equal(await read("\r"), "");
  assert.equal(await read("\u0003"), null);
});

test("prompt only when stdin and stdout are both a terminal", () => {
  const io = (i: boolean, o: boolean) =>
    ({
      input: { ...tty([]).input, isTTY: i },
      output: { isTTY: o, write: () => true },
    }) as PromptIO;
  assert.equal(interactive(io(true, true)), true);
  assert.equal(interactive(io(false, true)), false);
  assert.equal(interactive(io(true, false)), false);
});

test("what is asked: an env var or a saved value wins, and without a terminal nothing is", () => {
  const none = {
    interactive: true,
    unwrapToken: null,
    accessTokenOnly: null,
    savedRefreshToken: false,
    secret: null,
  };
  assert.deepEqual(whatToAsk(none), { token: true, secret: true });
  assert.deepEqual(whatToAsk({ ...none, interactive: false }), { token: false, secret: false });
  assert.deepEqual(whatToAsk({ ...none, unwrapToken: "rvu_x" }), { token: false, secret: true });
  assert.deepEqual(whatToAsk({ ...none, accessTokenOnly: "a.b.c" }), {
    token: false,
    secret: true,
  });
  assert.deepEqual(whatToAsk({ ...none, savedRefreshToken: true }), { token: false, secret: true });
  // `secret` is RAVN_HOOK_SECRET, or else the saved one.
  assert.deepEqual(whatToAsk({ ...none, secret: "s" }), { token: true, secret: false });
});

test("a secret set on a running server takes effect at once: 503 before, 200 after", async () => {
  const deps: ServerDeps = {
    secret: null,
    viewToken: TOKEN,
    showValues: false,
    retentionHours: 24,
    version: "0.0.0-test",
    store: new DeliveryStore({ retentionHours: 24 }),
    schema: () => schema,
    schemaId: SCHEMA_ID,
  };
  const server = createHookServer(deps);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const before = await deliver(base, "/classify", envelope("classify"), { stage: "classify" });
    assert.equal(before.status, 503);
    deps.secret = SECRET;
    const after = await deliver(base, "/classify", envelope("classify"), { stage: "classify" });
    assert.equal(after.status, 200);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("the saved secret: mode 600, kept across a renew, and --forget's removal keeps the chain", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "echo-state-")), "state.json");
  assert.equal(savedHookSecret(file), null);
  saveHookSecret(file, SECRET_VALUE);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(savedHookSecret(file), SECRET_VALUE);
  assert.equal(hasSavedRefreshToken(file), false, "a secret alone is not a service account");

  const ravn = new FakeRavn();
  await ravn.start();
  try {
    const account = new ServiceAccount({
      gatewayUrl: `${ravn.base}/api/gateway/graphql`,
      unwrapToken: ravn.newUnwrapToken(),
      stateFile: file,
      log: () => {},
    });
    await account.start();
    assert.equal(account.status().state, "ok");
  } finally {
    await ravn.close();
  }
  assert.equal(savedHookSecret(file), SECRET_VALUE, "redeeming kept the secret");
  assert.equal(hasSavedRefreshToken(file), true);
  assert.equal(statSync(file).mode & 0o777, 0o600);

  saveHookSecret(file, undefined);
  assert.equal(savedHookSecret(file), null);
  assert.equal(hasSavedRefreshToken(file), true, "forgetting the secret kept the chain");
});

test("a state file that is not JSON is no saved secret", () => {
  const file = join(mkdtempSync(join(tmpdir(), "echo-state-")), "state.json");
  writeFileSync(file, "not json");
  assert.equal(savedHookSecret(file), null);
  saveHookSecret(file, SECRET_VALUE);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).hookSecret, SECRET_VALUE);
});
