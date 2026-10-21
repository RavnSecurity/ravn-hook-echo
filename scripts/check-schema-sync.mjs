#!/usr/bin/env node
// The vendored schema must be the published one, byte for byte.
//
// The hook validates against the schema fetched from its $id and falls back to
// schema/stage-contract.v1.json when it cannot reach it. This check keeps the
// fallback honest: if the published bytes differ, it fails and says how to
// update the vendored copy.
//
// Until the schema is served publicly, its $id answers with something that is
// not the schema (a redirect to a sign-in page). That is reported, and fails
// only with SCHEMA_SYNC_STRICT=1, so CI stays green while publication is
// pending and turns strict once it lands.
import { readFileSync } from "node:fs";

const ID = "https://ravnsecurity.io/schema/stage-contract.v1.json";
const VENDORED = new URL("../schema/stage-contract.v1.json", import.meta.url);
const strict = process.env.SCHEMA_SYNC_STRICT === "1";

const vendored = readFileSync(VENDORED);
const vendoredDoc = JSON.parse(vendored.toString("utf8"));
if (vendoredDoc.$id !== ID) {
  console.error(`schema-sync: the vendored copy's $id is ${vendoredDoc.$id}, not ${ID}`);
  process.exit(1);
}

let res;
try {
  res = await fetch(ID, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
} catch (e) {
  const msg = `schema-sync: could not fetch ${ID}: ${e.message}`;
  console.error(msg);
  process.exit(strict ? 1 : 0);
}
const published = Buffer.from(await res.arrayBuffer());
let publishedDoc = null;
try {
  publishedDoc = JSON.parse(published.toString("utf8"));
} catch {}

if (!res.ok || !publishedDoc || publishedDoc.$id !== ID) {
  console.warn(
    `schema-sync: ${ID} is not published yet (${res.status} from ${res.url}, ` +
      `${res.headers.get("content-type")}). Nothing to compare.` +
      (strict ? "" : " Not failing: set SCHEMA_SYNC_STRICT=1 to fail on this."),
  );
  process.exit(strict ? 1 : 0);
}

if (Buffer.compare(published, vendored) !== 0) {
  console.error(
    `schema-sync: schema/stage-contract.v1.json differs from ${ID}.\n` +
      `Update it with:\n  curl -sSL ${ID} -o schema/stage-contract.v1.json`,
  );
  process.exit(1);
}
console.log(`schema-sync: the vendored copy equals ${ID}`);
