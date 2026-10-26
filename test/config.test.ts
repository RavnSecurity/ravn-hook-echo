import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.js";
import { HOOKABLE } from "../src/stages.js";

const env = { RAVN_HOOK_SECRET: "s" };

test("defaults", () => {
  const c = parseConfig([], env);
  assert.ok(c !== "help");
  assert.equal(c.port, 8080);
  assert.equal(c.host, "0.0.0.0");
  assert.equal(c.retentionHours, 24);
  assert.equal(c.showValues, false);
  assert.match(c.viewToken, /^[0-9a-f]{32}$/, "128-bit random");
});

test("no secret boots unconfigured, rather than refusing to start", () => {
  const c = parseConfig([], {});
  assert.ok(c !== "help");
  assert.equal(c.secret, null);
});

test("a VIEW_TOKEN from the environment is marked so, so it is never printed", () => {
  const set = parseConfig([], { ...env, VIEW_TOKEN: "t" });
  const generated = parseConfig([], env);
  assert.ok(set !== "help" && generated !== "help");
  assert.deepEqual([set.viewTokenFromEnv, generated.viewTokenFromEnv], [true, false]);
});

test("--show-values is refused unless bound to loopback", () => {
  assert.throws(() => parseConfig(["--show-values"], env), /refused/);
  assert.throws(() => parseConfig(["--show-values", "--host", "192.168.1.5"], env), /refused/);
  for (const host of ["127.0.0.1", "::1"]) {
    const c = parseConfig(["--show-values", "--host", host], env);
    assert.ok(c !== "help" && c.showValues);
  }
  const viaEnv = parseConfig(["--show-values"], { ...env, HOST: "127.0.0.1" });
  assert.ok(viaEnv !== "help" && viaEnv.showValues);
});

test("VIEW_TOKEN, PORT, RETENTION_HOURS, PUBLIC_BASE_URL", () => {
  const c = parseConfig([], {
    ...env,
    VIEW_TOKEN: "t",
    PORT: "9000",
    RETENTION_HOURS: "2",
    PUBLIC_BASE_URL: "https://hooks.example.com/",
  });
  assert.ok(c !== "help");
  assert.deepEqual(
    [c.viewToken, c.port, c.retentionHours, c.publicBaseUrl],
    ["t", 9000, 2, "https://hooks.example.com"],
  );
});

test("unknown flags are refused", () => {
  assert.throws(() => parseConfig(["--nope"], env), /unknown flag/);
});

test("service account settings", () => {
  const c = parseConfig([], env);
  assert.ok(c !== "help");
  assert.deepEqual(
    [c.unwrapToken, c.accessTokenOnly, c.ravnUrl, c.answerStages],
    [null, null, "https://apps.ravnsecurity.io", [...HOOKABLE]],
  );
  assert.match(c.stateFile, /\.ravn-hook-echo[/\\]state\.json$/);

  const d = parseConfig([], {
    ...env,
    RAVN_UNWRAP_TOKEN: " u ",
    RAVN_STATE_FILE: "/data/state.json",
    ANSWER_STAGES: "route, classify,route",
    RAVN_URL: "https://apps.ravn.localhost/",
  });
  assert.ok(d !== "help");
  assert.deepEqual(
    [d.unwrapToken, d.stateFile, d.answerStages, d.ravnUrl],
    ["u", "/data/state.json", ["route", "classify"], "https://apps.ravn.localhost"],
  );

  const none = parseConfig([], { ...env, ANSWER_STAGES: "none" });
  assert.ok(none !== "help");
  assert.deepEqual(none.answerStages, []);

  assert.throws(() => parseConfig([], { ...env, ANSWER_STAGES: "intake" }), /ANSWER_STAGES/);
  assert.throws(
    () => parseConfig([], { ...env, RAVN_UNWRAP_TOKEN: "u", RAVN_ACCESS_TOKEN_ONLY: "a" }),
    /not both/,
  );
});

test("--tunnel: Cloudflare by default, or the provider named by the flag or TUNNEL", () => {
  const tunnel = (argv: string[], extra: Record<string, string> = {}) => {
    const c = parseConfig(argv, { ...env, NGROK_AUTHTOKEN: "n", ...extra });
    assert.ok(c !== "help");
    return c.tunnel;
  };
  assert.equal(tunnel([]), null);
  assert.deepEqual(tunnel(["--tunnel"]), { provider: "cloudflare" });
  assert.deepEqual(tunnel(["--tunnel=cloudflare"]), { provider: "cloudflare" });
  assert.deepEqual(tunnel(["--tunnel", "ngrok"]), {
    provider: "ngrok",
    authtoken: "n",
    domain: null,
  });
  assert.deepEqual(tunnel([], { TUNNEL: "Cloudflare" }), { provider: "cloudflare" });
  assert.deepEqual(tunnel(["--tunnel=cloudflare"], { TUNNEL: "ngrok" }), {
    provider: "cloudflare",
  });
  assert.deepEqual(tunnel([], { TUNNEL: "ngrok", NGROK_DOMAIN: "https://my-hook.ngrok.app/" }), {
    provider: "ngrok",
    authtoken: "n",
    domain: "my-hook.ngrok.app",
  });
  // A bare --tunnel before another flag does not swallow it.
  const c = parseConfig(["--tunnel", "--port", "9000"], env);
  assert.ok(c !== "help");
  assert.deepEqual([c.tunnel, c.port], [{ provider: "cloudflare" }, 9000]);

  assert.throws(() => tunnel(["--tunnel=localtunnel"]), /"localtunnel" is not one of/);
  assert.throws(() => tunnel([], { TUNNEL: "bore" }), /"bore" is not one of/);
});

test("--tunnel: ngrok needs NGROK_AUTHTOKEN", () => {
  assert.throws(() => parseConfig(["--tunnel=ngrok"], env), /needs NGROK_AUTHTOKEN/);
  assert.throws(
    () => parseConfig([], { ...env, TUNNEL: "ngrok", NGROK_AUTHTOKEN: "  " }),
    /needs NGROK_AUTHTOKEN/,
  );
});

test("a tunnel with PUBLIC_BASE_URL is ambiguous, and refused", () => {
  assert.throws(
    () => parseConfig(["--tunnel"], { ...env, PUBLIC_BASE_URL: "https://hooks.example.com" }),
    /not both/,
  );
  assert.throws(
    () => parseConfig([], { ...env, TUNNEL: "cloudflare", PUBLIC_BASE_URL: "https://x.example" }),
    /not both/,
  );
});

test("--show-values is refused with a tunnel, even on loopback: the viewer is public", () => {
  assert.throws(
    () => parseConfig(["--show-values", "--host", "127.0.0.1", "--tunnel"], env),
    /refused with a tunnel/,
  );
});
