import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { listenPublic, type OpenTunnel, TunnelError } from "../src/tunnel.js";

/** No test here opens a real tunnel: the provider is a fake, in-process or as the cloudflared binary. */

const BIN = fileURLToPath(new URL("../../bin/ravn-hook-echo.js", import.meta.url));
const PUBLIC = "https://quiet-words-here.trycloudflare.com";

const ok = (res: Response | null) => res?.ok === true;

test("listenPublic without a tunnel: the configured base, and close stops the server", async () => {
  const server = createServer((_q, r) => r.end("ok"));
  const up = await listenPublic(server, {
    port: 0,
    host: "127.0.0.1",
    publicBaseUrl: "http://localhost:8080",
    tunnel: null,
  });
  assert.equal(up.base, "http://localhost:8080");
  assert.equal(server.listening, true);
  await up.close();
  assert.equal(server.listening, false);
});

test("listenPublic with a tunnel: its address is the base, it dials loopback, and closes first", async () => {
  const events: string[] = [];
  let dialed = "";
  const open: OpenTunnel = async (config, target) => {
    assert.deepEqual(config, { provider: "cloudflare" });
    dialed = target;
    events.push("open");
    return {
      url: `${PUBLIC}/`,
      close: async () => {
        events.push(`close (server listening: ${server.listening})`);
      },
    };
  };
  const server = createServer((_q, r) => r.end("ok"));
  const up = await listenPublic(
    server,
    {
      port: 0,
      host: "0.0.0.0",
      publicBaseUrl: "http://localhost:0",
      tunnel: { provider: "cloudflare" },
    },
    open,
  );
  assert.equal(up.base, PUBLIC);
  const { port } = server.address() as { port: number };
  assert.equal(dialed, `http://127.0.0.1:${port}`, "a wildcard bind is dialed on loopback");
  assert.ok(ok(await fetch(dialed).catch(() => null)));
  await up.close();
  assert.deepEqual(events, ["open", "close (server listening: true)"]);
  assert.equal(server.listening, false);
});

test("listenPublic: a tunnel that fails to open closes the server and passes the reason on", async () => {
  const server = createServer((_q, r) => r.end("ok"));
  await assert.rejects(
    listenPublic(
      server,
      { port: 0, host: "127.0.0.1", publicBaseUrl: "", tunnel: { provider: "cloudflare" } },
      async () => {
        throw new TunnelError("cloudflare: 429 Too Many Requests");
      },
    ),
    /429 Too Many Requests/,
  );
  assert.equal(server.listening, false);
});

// The real CLI, with a fake cloudflared: it prints what cloudflared prints.

function fakeCloudflared(script: string): { bin: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "echo-tunnel-"));
  const bin = join(dir, "cloudflared");
  writeFileSync(bin, `#!/bin/sh\necho "$@" > "${dir}/args"\n${script}\n`);
  chmodSync(bin, 0o755);
  return { bin, dir };
}

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

function spawnHook(port: number, env: Record<string, string>) {
  const child = spawn(process.execPath, [BIN, "--no-fetch-schema", "--tunnel"], {
    env: {
      PATH: process.env.PATH ?? "",
      HOST: "127.0.0.1",
      PORT: String(port),
      RAVN_HOOK_SECRET: "s",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => {
    out += b;
  });
  child.stderr.on("data", (b) => {
    out += b;
  });
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  return { child, output: () => out, exited };
}

async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("timed out");
}

test("--tunnel: prints the tunnel's URLs, and SIGTERM closes the tunnel with the server", async () => {
  const fake = fakeCloudflared(
    [
      `trap 'echo stopped > "${"$(dirname $0)"}/stopped"; exit 0' INT TERM`,
      `echo "2026-10-26T00:00:00Z INF |  ${PUBLIC}  |" >&2`,
      `echo "2026-10-26T00:00:01Z INF Registered tunnel connection connIndex=0 connection=0f6f6c1e-3b9e-4b8e-9c3e-2f1a6f7d8e9a event=0 ip=198.41.200.13 location=lhr01 protocol=quic" >&2`,
      "while :; do sleep 0.1; done",
    ].join("\n"),
  );
  const port = await freePort();
  const hook = spawnHook(port, { CLOUDFLARED_BIN: fake.bin });
  try {
    await until(() => hook.output().includes("no service account"));
    const out = hook.output();
    assert.match(out, new RegExp(`tunnel: cloudflare, public at ${PUBLIC}`));
    assert.match(out, new RegExp(`  ${PUBLIC}/classify\\n`));
    assert.match(out, new RegExp(`  ${PUBLIC}/view#k=[0-9a-f]{32}`));
    assert.doesNotMatch(out, /localhost/);
    assert.equal(
      readFileSync(join(fake.dir, "args"), "utf8").trim(),
      `tunnel --url http://127.0.0.1:${port}`,
    );
    assert.ok(ok(await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null)));
  } finally {
    hook.child.kill("SIGTERM");
  }
  assert.equal(await hook.exited, 0);
  assert.ok(existsSync(join(fake.dir, "stopped")), "cloudflared was stopped");
});

test("--tunnel: a tunnel that fails exits non-zero with the reason, and never prints a hook URL", async () => {
  const fake = fakeCloudflared(
    [
      `echo "2026-10-26T00:00:00Z INF Requesting new quick Tunnel on trycloudflare.com..." >&2`,
      `echo "2026-10-26T00:00:01Z ERR failed to request quick Tunnel: 429 Too Many Requests" >&2`,
      "exit 1",
    ].join("\n"),
  );
  const port = await freePort();
  const hook = spawnHook(port, { CLOUDFLARED_BIN: fake.bin });
  assert.equal(await hook.exited, 1);
  const out = hook.output();
  assert.match(out, /the tunnel did not open: cloudflare: failed to request quick Tunnel: 429/);
  assert.doesNotMatch(out, /hook URLs|localhost|127\.0\.0\.1:\d+\//);
  assert.equal(await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null), null);
});

test("--tunnel=ngrok without NGROK_AUTHTOKEN is a config error, before anything starts", async () => {
  const hook = spawn(process.execPath, [BIN, "--no-fetch-schema", "--tunnel=ngrok"], {
    env: { PATH: process.env.PATH ?? "", PORT: String(await freePort()) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  hook.stderr.on("data", (b) => {
    err += b;
  });
  const code = await new Promise<number | null>((r) => hook.once("exit", (c) => r(c)));
  assert.equal(code, 2);
  assert.match(err, /needs NGROK_AUTHTOKEN/);
});
