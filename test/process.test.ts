import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { secretQuestion, TOKEN_QUESTION } from "../src/prompt.js";
import { FakeRavn, SECRET_MARK } from "./fake-ravn.js";
import { CANARY, envelope } from "./fixtures.js";
import { deliver } from "./helpers.js";

/**
 * The real CLI, as it runs in prod: its logs go to a log store, so nothing it
 * prints may carry a token, a secret or a packet value. Every credential here
 * carries SECRET_MARK and every packet value CANARY, so the check is a
 * substring search over everything it wrote.
 */
const BIN = fileURLToPath(new URL("../../bin/ravn-hook-echo.js", import.meta.url));
const HOOK_SECRET = `hook-secret-${SECRET_MARK}`;
const VIEW_TOKEN = `view-token-${SECRET_MARK}`;

let ravn: FakeRavn;
before(async () => {
  ravn = new FakeRavn();
  await ravn.start();
});
after(() => ravn.close());

interface Hook {
  base: string;
  output: () => string;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

async function run(env: Record<string, string>, args: string[] = []): Promise<Hook> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [BIN, "--no-fetch-schema", ...args], {
    env: { PATH: process.env.PATH ?? "", HOST: "127.0.0.1", PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (b) => {
    out += b;
  });
  child.stderr?.on("data", (b) => {
    out += b;
  });
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  const base = `http://127.0.0.1:${port}`;
  await until(async () => (await fetch(`${base}/healthz`).catch(() => null))?.ok === true);
  return {
    base,
    output: () => out,
    stop: async () => {
      child.kill("SIGTERM");
      await exited;
    },
  };
}

async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("timed out");
}

const viewer = async (base: string) =>
  (await (
    await fetch(`${base}/api/deliveries`, { headers: { authorization: `Bearer ${VIEW_TOKEN}` } })
  ).json()) as { configured: boolean; account: { state: string; code: string | null } | null };

function assertClean(output: string): void {
  assert.equal(output.includes(SECRET_MARK), false, `a token or secret was logged:\n${output}`);
  assert.equal(output.includes(CANARY), false, `a packet value was logged:\n${output}`);
}

test("unconfigured, it boots, serves /healthz, refuses deliveries with 503, and the viewer says so", async () => {
  const hook = await run({ VIEW_TOKEN });
  try {
    const health = await fetch(`${hook.base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, configured: false });

    const res = await deliver(hook.base, "/classify", envelope("classify"), { stage: "classify" });
    assert.equal(res.status, 503);
    assert.match(String(res.json.error), /not configured: RAVN_HOOK_SECRET is not set/);

    const view = await viewer(hook.base);
    assert.equal(view.configured, false);
    assert.equal(view.account, null, "no unwrap token and no state: answers and reads off");
    assert.match(hook.output(), /not configured/);
    assert.match(hook.output(), /no service account: answers and reads off/);
    assert.equal(hook.output().includes(TOKEN_QUESTION), false, "no terminal: no prompt");
    assert.doesNotMatch(hook.output(), /paste its signing secret/);
  } finally {
    await hook.stop();
  }
  assertClean(hook.output());
});

test("unconfigured with no VIEW_TOKEN, no viewer token is printed", async () => {
  const hook = await run({});
  await hook.stop();
  assert.match(hook.output(), /viewer: off until VIEW_TOKEN is set/);
  assert.doesNotMatch(hook.output(), /#k=[0-9a-f]/);
});

test("state survives a restart on a spent unwrap token, and nothing it logs carries a token, secret or value", async () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), "echo-proc-")), "state.json");
  const env = {
    RAVN_HOOK_SECRET: HOOK_SECRET,
    VIEW_TOKEN,
    RAVN_UNWRAP_TOKEN: ravn.newUnwrapToken(),
    RAVN_STATE_FILE: stateFile,
    RAVN_URL: ravn.base,
  };
  const answered = async (hook: Hook, runId: string) => {
    const body = envelope("classify", { stageRunId: `${CANARY}-${runId}-run-classify` });
    const res = await deliver(hook.base, "/classify", body, {
      stage: "classify",
      secret: HOOK_SECRET,
      deliveryId: runId,
    });
    assert.equal(res.status, 200);
    await until(() => ravn.answers.some((a) => a.body.stageRunId === body.stageRunId));
    const answer = ravn.answers.find((a) => a.body.stageRunId === body.stageRunId);
    assert.equal(answer?.code, "accepted");
  };

  const first = await run(env);
  try {
    await answered(first, "run-1");
  } finally {
    await first.stop();
  }
  const redeems = ravn.redeems;

  // The same, now spent, unwrap token: the chain in the state file is used.
  const second = await run(env);
  try {
    await answered(second, "run-2");
    const view = await viewer(second.base);
    assert.equal(view.configured, true);
    assert.equal(view.account?.state, "ok", "a spent unwrap token with live state is not an error");
    assert.equal(view.account?.code, null);
  } finally {
    await second.stop();
  }
  assert.equal(ravn.redeems, redeems, "the unwrap token was not presented again");
  assert.match(second.output(), /renewing from/);
  assert.match(
    second.output(),
    /#k=<VIEW_TOKEN>/,
    "a VIEW_TOKEN from the environment is not printed",
  );

  assertClean(first.output());
  assertClean(second.output());
});

function stateWith(content: Record<string, unknown>): string {
  const file = join(mkdtempSync(join(tmpdir(), "echo-proc-")), "state.json");
  writeFileSync(file, JSON.stringify(content), { mode: 0o600 });
  return file;
}

test("a signing secret saved at an earlier prompt configures it, and is not asked for or printed", async () => {
  const stateFile = stateWith({ hookSecret: HOOK_SECRET });
  const hook = await run({ VIEW_TOKEN, RAVN_STATE_FILE: stateFile });
  try {
    const res = await deliver(hook.base, "/classify", envelope("classify"), {
      stage: "classify",
      secret: HOOK_SECRET,
    });
    assert.equal(res.status, 200);
    assert.equal((await viewer(hook.base)).configured, true);
    assert.equal((await viewer(hook.base)).account, null, "a secret alone is no service account");
  } finally {
    await hook.stop();
  }
  assert.match(hook.output(), /signing secret: the one saved in/);
  assert.doesNotMatch(hook.output(), /not configured/);
  assertClean(hook.output());
});

test("RAVN_HOOK_SECRET wins over a saved one", async () => {
  const stateFile = stateWith({ hookSecret: `saved-${SECRET_MARK}` });
  const hook = await run({ VIEW_TOKEN, RAVN_STATE_FILE: stateFile, RAVN_HOOK_SECRET: HOOK_SECRET });
  try {
    const opts = { stage: "classify" as const };
    const saved = await deliver(hook.base, "/classify", envelope("classify"), {
      ...opts,
      secret: `saved-${SECRET_MARK}`,
    });
    assert.equal(saved.status, 401);
    const env = await deliver(hook.base, "/classify", envelope("classify"), {
      ...opts,
      secret: HOOK_SECRET,
    });
    assert.equal(env.status, 200);
  } finally {
    await hook.stop();
  }
  assertClean(hook.output());
});

test("--forget removes the saved secret and keeps the rest of the state file", async () => {
  const stateFile = stateWith({ hookSecret: HOOK_SECRET, other: "kept" });
  const hook = await run({ VIEW_TOKEN, RAVN_STATE_FILE: stateFile }, ["--forget"]);
  try {
    const res = await deliver(hook.base, "/classify", envelope("classify"), {
      stage: "classify",
      secret: HOOK_SECRET,
    });
    assert.equal(res.status, 503);
  } finally {
    await hook.stop();
  }
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), { other: "kept" });
  assert.match(hook.output(), /forgot the signing secret/);
  assertClean(hook.output());
});

/**
 * On a real terminal: util-linux `script` gives the CLI a pseudo-terminal, so
 * this is what a person sees, echo and all. Linux only (CI and the devcontainer).
 */
const SCRIPT = "/usr/bin/script";
test("on a terminal it asks for the token and then the secret, which takes effect without a restart", {
  skip: process.platform !== "linux" || !existsSync(SCRIPT) ? "needs util-linux script" : false,
}, async () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), "echo-pty-")), "state.json");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(
    SCRIPT,
    ["-qfec", `${process.execPath} ${BIN} --no-fetch-schema`, "/dev/null"],
    {
      env: {
        PATH: process.env.PATH ?? "",
        HOST: "127.0.0.1",
        PORT: String(port),
        VIEW_TOKEN,
        RAVN_STATE_FILE: stateFile,
        RAVN_URL: ravn.base,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let out = "";
  child.stdout?.on("data", (b) => {
    out += b;
  });
  child.stderr?.on("data", (b) => {
    out += b;
  });
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  try {
    await until(() => out.includes(TOKEN_QUESTION));
    const unwrap = ravn.newUnwrapToken();
    child.stdin?.write(`${unwrap}\r`);
    await until(() => out.includes(secretQuestion(`${base}/`)));
    assert.match(out, /service account on .*: ok/);

    const body = envelope("classify");
    const opts = { stage: "classify" as const, secret: HOOK_SECRET };
    assert.equal((await deliver(base, "/classify", body, opts)).status, 503);

    child.stdin?.write("has a space\r");
    await until(() => out.includes("whitespace"));
    child.stdin?.write(`${HOOK_SECRET}\r`);
    await until(() => out.includes("ready: deliveries are verified with the signing secret"));
    assert.equal((await deliver(base, "/classify", body, opts)).status, 200);

    assert.equal(statSync(stateFile).mode & 0o777, 0o600);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.hookSecret, HOOK_SECRET);
    assert.equal(typeof state.refreshToken, "string", "the chain sits beside it");
  } finally {
    child.stdin?.write("\u0003");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(timer);
  }
  assertClean(out);
});
