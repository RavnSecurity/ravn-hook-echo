import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, parseConfig } from "../src/config.js";
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

test("a secret is required", () => {
  assert.throws(() => parseConfig([], {}), ConfigError);
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
