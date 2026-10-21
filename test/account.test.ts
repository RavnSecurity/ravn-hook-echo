import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ServiceAccount } from "../src/account.js";
import { ravnUrls } from "../src/answers.js";
import { FakeRavn, SECRET_MARK } from "./fake-ravn.js";

let ravn: FakeRavn;
before(async () => {
  ravn = new FakeRavn();
  await ravn.start();
});
after(() => ravn.close());

function account(
  stateFile: string,
  opts: { unwrap?: string | null; now?: () => number; log?: string[] } = {},
) {
  const log = opts.log ?? [];
  return new ServiceAccount({
    gatewayUrl: ravnUrls(ravn.base).gateway,
    unwrapToken: opts.unwrap ?? null,
    stateFile,
    log: (l) => log.push(l),
    ...(opts.now ? { now: opts.now } : {}),
  });
}

const stateIn = () => join(mkdtempSync(join(tmpdir(), "echo-state-")), "nested", "state.json");
const saved = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as { refreshToken: string; unwrap: string };

test("first start redeems the unwrap token and saves the refresh token, mode 600", async () => {
  const file = stateIn();
  const log: string[] = [];
  const a = account(file, { unwrap: ravn.newUnwrapToken(), log });
  await a.start();
  assert.equal(a.status().state, "ok");
  assert.ok((await a.accessToken())?.startsWith("access-"));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(saved(file).refreshToken, /^refresh-/);
  assert.equal(
    log.join("\n").includes(SECRET_MARK),
    false,
    "no token, unwrap, access or refresh, is logged",
  );
  assert.equal(JSON.stringify(a.status()).includes(SECRET_MARK), false, "status carries no token");
});

test("a restart renews from the state file instead of redeeming again, and stores the NEW refresh token", async () => {
  const file = stateIn();
  const unwrap = ravn.newUnwrapToken();
  await account(file, { unwrap }).start();
  const first = saved(file).refreshToken;
  const redeems = ravn.redeems;

  const again = account(file, { unwrap });
  await again.start();
  assert.equal(ravn.redeems, redeems, "the spent unwrap token is not presented again");
  assert.equal(again.status().state, "ok");
  assert.notEqual(saved(file).refreshToken, first, "the old one is spent; the new one is saved");
});

test("a new unwrap token is redeemed even with a saved chain; a used one falls back to the chain", async () => {
  const file = stateIn();
  await account(file, { unwrap: ravn.newUnwrapToken() }).start();
  const before = saved(file).unwrap;

  await account(file, { unwrap: ravn.newUnwrapToken() }).start();
  assert.notEqual(saved(file).unwrap, before, "the new handover was redeemed");

  const spent = `unwrap-${SECRET_MARK}-spent`;
  const fallback = account(file, { unwrap: spent });
  await fallback.start();
  assert.equal(fallback.status().state, "ok", "renewed from the saved chain after `used`");
});

test("renews when under 60 s are left, once however many callers ask at the same time", async () => {
  let now = 1_000_000;
  const a = account(stateIn(), { unwrap: ravn.newUnwrapToken(), now: () => now });
  await a.start();
  const first = await a.accessToken();
  const renews = ravn.renews;

  now += 800_000; // 100 s left of 900: no renew yet
  assert.equal(await a.accessToken(), first);
  assert.equal(ravn.renews, renews);

  now += 50_000; // 50 s left
  const tokens = await Promise.all([a.accessToken(), a.accessToken(), a.accessToken()]);
  assert.equal(ravn.renews, renews + 1, "one renew: two would present one refresh token twice");
  assert.equal(new Set(tokens).size, 1);
  assert.notEqual(tokens[0], first);
  assert.equal(a.status().renewals, 1);
});

test("a 401 renews, once, and a token already replaced is not renewed again", async () => {
  const a = account(stateIn(), { unwrap: ravn.newUnwrapToken() });
  await a.start();
  const spent = (await a.accessToken()) as string;
  const renews = ravn.renews;
  const [x, y] = await Promise.all([a.unauthorized(spent), a.unauthorized(spent)]);
  assert.equal(ravn.renews, renews + 1);
  assert.equal(x, y);
  assert.equal(await a.unauthorized(spent), x, "already replaced: no renew");
  assert.equal(ravn.renews, renews + 1);
});

test("a reused refresh token is refused, the chain is dead, and it says so", async () => {
  const file = stateIn();
  await account(file, { unwrap: ravn.newUnwrapToken() }).start();
  const copy = readFileSync(file, "utf8");
  // Two deployments holding one credential: the first renews, the second presents the spent one.
  await account(file).start();
  writeFileSync(file, copy);
  const second = account(file);
  await second.start();
  assert.equal(second.status().state, "failing");
  assert.equal(second.status().code, "reused");
  assert.equal(await second.accessToken(), null);
});

test("no credential at all: failing, with a code, and no token", async () => {
  const a = account(stateIn());
  await a.start();
  assert.deepEqual([a.status().state, a.status().code], ["failing", "no-credential"]);
  assert.equal(await a.accessToken(), null);
});

test("RAVN_ACCESS_TOKEN_ONLY is used as is and never renewed", async () => {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const jwt = `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`;
  const renews = ravn.renews;
  const a = new ServiceAccount({
    gatewayUrl: ravnUrls(ravn.base).gateway,
    accessTokenOnly: jwt,
    stateFile: stateIn(),
    log: () => {},
  });
  await a.start();
  assert.equal(await a.accessToken(), jwt);
  assert.equal(await a.unauthorized(jwt), null);
  assert.equal(ravn.renews, renews);
  assert.equal(a.status().mode, "access-token-only");
  assert.equal(a.status().accessExpiresAt, new Date(exp * 1000).toISOString());
});
