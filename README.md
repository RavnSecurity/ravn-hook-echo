# ravn-hook-echo

A reference **Ravn Hook** for every triage stage a program can send to a hook. It
verifies what Ravn sends, validates it against the public stage contract, answers
with a documented echo, and misbehaves on request so you can watch how Ravn
reacts. A viewer shows what it received without ever showing a value from it.

It is built only against the **public** stage contract,
[`stage-contract.v1.json`](https://ravnsecurity.io/schema/stage-contract.v1.json).
Anything it can do, your own hook can do too.

- [What a hook is](#what-a-hook-is)
- [Run it](#run-it)
- [Point a program at it](#point-a-program-at-it)
- [What it does with each delivery](#what-it-does-with-each-delivery)
- [Modes: misbehaving on request](#modes-misbehaving-on-request)
- [What the echo answers](#what-the-echo-answers)
- [The viewer](#the-viewer)
- [Configuration](#configuration)
- [Develop](#develop)

## What a hook is

Ravn triages a security report in seven stages: Intake, Classify, Route, Assess,
Review, Follow-up and Knowledge. Each stage has one typed input and one typed
output, published as JSON Schema.

A program can run Ravn's built-in for a stage, or send that stage to a **hook**:
your team's own tool, reached over HTTPS. When a case reaches a stage sent to a
hook, Ravn POSTs the stage's packet to the hook's URL, signed with the hook's
secret.

- Six stages can be sent to a hook: Classify, Route, Assess, Review, Follow-up and
  Knowledge. Intake cannot yet, because a tool cannot yet send reports in.
- A hook **only receives** today. Ravn does not read its response body. A case
  whose hook never answers goes to a person.
- A packet never carries a report body, a proof of concept or an attachment. Every
  empty value says why it is empty, such as `not-observed` or `not-run`.
- A delivery is retried until the hook answers `2xx`. A packet is never dropped.

## Run it

With Node 22 or later:

```bash
RAVN_HOOK_SECRET='<the signing secret Ravn showed you>' npx ravn-hook-echo
```

Or as a container:

```bash
docker build -t ravn-hook-echo .
docker run --rm -p 8080:8080 -e RAVN_HOOK_SECRET='<secret>' ravn-hook-echo
```

At start it prints one URL per stage and the viewer's private URL:

```text
ravn-hook-echo 0.1.0 listening on 0.0.0.0:8080
schema: published (https://ravnsecurity.io/schema/stage-contract.v1.json)
hook URLs, one per stage:
  http://localhost:8080/classify
  http://localhost:8080/route
  http://localhost:8080/assess
  http://localhost:8080/review
  http://localhost:8080/follow-up
  http://localhost:8080/knowledge
  http://localhost:8080/  (dispatches on x-ravn-event)
viewer (keep this URL private; the token is the part after #k=):
  http://localhost:8080/view#k=3f9c…
```

Ravn has to reach the hook over the internet. Run it somewhere with a public
HTTPS address, or put a tunnel in front of your laptop, and set `PUBLIC_BASE_URL`
to that address so the printed URLs are the ones to paste into Ravn.

## Point a program at it

1. In Ravn, an org admin creates a hook for the program. Its delivery URL is one
   of the URLs above, such as `https://hooks.example.com/assess`.
2. Ravn shows the hook's signing secret **once**. Start ravn-hook-echo with it as
   `RAVN_HOOK_SECRET`.
3. In the program's stage settings, send a stage to the hook and publish. Cases
   that arrive after that are delivered to it.
4. Open the viewer URL. Each delivery appears within a few seconds.

One instance serves every stage. Give each stage its own URL (`/classify`,
`/assess`, …), or send them all to `/` and let it dispatch on `x-ravn-event`.

## What it does with each delivery

In order:

1. **Verify.** `x-ravn-signature` is `sha256=<hex>`, an HMAC-SHA256 over the raw
   body bytes with the signing secret. It is compared in constant time. An
   unsigned or badly signed request is answered `401`, and **nothing about it is
   stored**: the endpoint is on the internet.
2. **Dedupe.** `x-ravn-delivery` is stable across retries of one delivery. A
   delivery seen before is marked as a retry. `x-ravn-attempt` says which attempt
   this is.
3. **Validate.** The body is checked against the stage's envelope in the public
   schema. The schema is fetched from its `$id` at start and every hour after,
   with the copy in `schema/` as a fallback. A failure is reported by JSON path
   and keyword, never by value.
4. **Echo.** It computes a schema-valid output for the stage from the packet's
   `inputDigest`. See [What the echo answers](#what-the-echo-answers).
5. **Respond** as the URL's mode says.

The response body is JSON:

```json
{
  "stage": "assess",
  "deliveryId": "…",
  "attempt": 1,
  "duplicate": false,
  "mode": "ok",
  "note": "ok",
  "schema": { "valid": true, "failures": [] },
  "output": { "proposed": { "value": "accept" }, "…": "…" }
}
```

An invalid packet is still answered as the mode says, so that one bad field does
not turn into a retry loop. The failures are in `schema.failures` and in the
viewer.

### The headers Ravn sends

| Header | Value |
| --- | --- |
| `x-ravn-signature` | `sha256=<hex>`: HMAC-SHA256 of the raw body with the signing secret |
| `x-ravn-event` | `stage.<stage>.requested`, such as `stage.assess.requested` |
| `x-ravn-delivery` | The delivery's id, the same on every retry. Dedupe on it |
| `x-ravn-attempt` | `1`, `2`, … Informational: the body and signature do not change |
| `user-agent` | `Ravn-Webhook/1` |

### Verifying a signature in your own hook

The scheme is the one GitHub and HackerOne use for webhooks:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice("sha256=".length).toLowerCase());
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"));
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

Sign the bytes as received. Parsing the JSON and serialising it again is how a
signature stops matching.

## Modes: misbehaving on request

The URL is the only configuration Ravn sends a hook, so behaviour is chosen by
the URL. Each mode exists to show one of Ravn's delivery rules happening. Any
stage takes any mode, and so does `/`.

| URL | Does | Shows |
| --- | --- | --- |
| `/assess` | `200` with the echo output | The happy path |
| `/assess/fail/3` | `500` for attempts 1 to 3, then `200` | Ravn retries a delivery until it is delivered |
| `/assess/fail/always` | `500` forever | A failing hook's packets are never lost, and Ravn shows the hook as failing |
| `/assess/slow/30s` | Waits 30 seconds, then `200` | Ravn's delivery timeout, then a retry |
| `/assess/status/410` | Answers `410`, or any status from 200 to 599 | How Ravn treats each status class |

- `fail/<n>` counts attempts with `x-ravn-attempt`. Without that header it counts
  the times it has seen the delivery id.
- `slow/<n>s` and `slow/<n>ms` are both accepted.
- `fail/<n>` is capped at 20 and `slow` at 120 seconds, so a public instance cannot
  be used to hold sockets open.

How Ravn treats a response today:

| Response | Ravn's view | What happens |
| --- | --- | --- |
| `2xx` | Delivered | Done |
| `3xx` | Redirect, not followed | Retried |
| `4xx` | Client error | Retried |
| `5xx` | Server error | Retried |
| No response, or a timeout | No response | Retried |

Retries back off, doubling up to a ceiling. Nothing gives up.

## What the echo answers

Ravn ignores a hook's response today. A hook only receives until the return path
exists. The echo output is still computed, returned in `output`, and shown in the
viewer, so the day Ravn reads answers this hook is already a drop-in.

It is a valid output for the stage, and it is **deterministic**: it is computed
from `inputDigest` alone, so the same packet always gets the same answer. No value
from the packet appears in it. When the body has no well-formed `inputDigest`,
the sha256 of the raw body is used instead, and the viewer says so.

Below, `byte[i]` is byte `i` of the digest, `digest[0:n]` is its first `n` hex
characters, and `pick(i, list)` is `list[byte[i] mod length]`. `<version>` is this
package's version. Instants are 2020-01-01T00:00:00Z plus the last four bytes of
the digest in seconds, modulo four years.

### Classify

| Field | Value |
| --- | --- |
| `verdict.isSecurityRelevant` | `{ value: byte[0] is odd }` |
| `verdict.severity` | `{ value: pick(1, critical, high, medium, low, none) }` |
| `verdict.category` | `{ value: "echo." + pick(2, injection, broken-auth, xss, misconfiguration, information-disclosure, ssrf, access-control, other) }` |
| `verdict.isLikelyAiSlop` | `{ value: byte[3] < 32 }` |
| `verdict.hasPoc` | `{ value: byte[4] is even }` |
| `verdict.confidence` | `{ value: byte[5] / 255 }`, two decimals |
| `verdict.weaknesses` | `{ value: [{ cwe: pick(6, CWE-79, CWE-89, CWE-287, CWE-352, CWE-22, CWE-200, CWE-502, CWE-918), label: "echo" }] }` |
| `verdict.products` | `{ value: null, reason: "not-observed" }` |
| `verdict.duplicateOf` | `{ value: null, reason: "not-observed" }` |
| `answers` | `{ value: { "echo.is-security-relevant": { p: byte[7] / 255 }, "echo.has-poc": { p: byte[8] / 255 } } }` |
| `ranBy` | `{ model: { value: "ravn-hook-echo" }, version: <version> }` |

### Route

| Field | Value |
| --- | --- |
| `action` | `pick(0, auto-close, escalate)` |
| `reasons` | `{ value: ["echo.digest-" + digest[0:8]] }` |
| `track` | `{ value: pick(1, light, standard, deep) }` |

### Assess

| Field | Value |
| --- | --- |
| `proposed` | `{ value: pick(0, accept, reject, needs-info, duplicate) }` |
| `severity` | `{ value: pick(1, critical, high, medium, low, none) }` |
| `ranBy` | `{ tool: "ravn-hook-echo", version: <version> }` |
| `card` | `{ value: "echo: input digest " + digest[0:16] }` |

### Review

| Field | Value |
| --- | --- |
| `outcome` | `pick(0, ACCEPTED, REJECTED, PENDING)` |
| `decidedAt` | The digest's instant |
| `actor` | `"ravn-hook-echo"` |
| `override` | `{ value: null, reason: "not-observed" }` |

### Follow-up

| Field | Value |
| --- | --- |
| `line` | `"echo/" + digest[0:8]` |
| `event` | `pick(0, shipped, not-affected, wont-fix)` |
| `ref` | `{ value: "echo:" + digest[0:16] }` |
| `at` | The digest's instant |

### Knowledge

| Field | Value |
| --- | --- |
| `precedentId` | `"echo-" + digest[0:16]` |
| `scope` | `pick(0, program, foundation)` |
| `reviewer` | `{ value: null, reason: "not-observed" }` |

## The viewer

If you have the viewer URL, you can see what the hook did. Nobody else can.

- The URL is `/view#k=<token>`. The token is in the **fragment**, which a browser
  never sends to a server. It stays out of access logs, proxies, `Referer` headers
  and link previews. The page reads it and calls `GET /api/deliveries` with
  `authorization: Bearer <token>`.
- The token is 128 bits of randomness, generated and printed once at start. Set
  `VIEW_TOKEN` to keep one across restarts. To rotate it, restart with a new one.
- Deliveries are kept in memory for `RETENTION_HOURS`, then they are gone. A
  restart forgets them all.

For each delivery it shows the stage, the event, the delivery id, the attempt,
when it was received, whether the signature was valid, whether the packet was
valid and which paths failed, `inputDigest`, the echo output, the response sent,
and the latency.

**It never shows a value from the packet.** Titles, URLs, external refs, handles,
ids and facts can identify a vulnerability or a person, even though a packet has
no report body. The viewer shows the packet's **shape** instead: each key, its
JSON type, and for an empty value, its reason.

```json
{
  "packet": {
    "report": {
      "title": "string · redacted",
      "account": { "value": { "handle": "string · redacted", "…": "…" } },
      "url": "absent · not-observed"
    },
    "bodyAccess": "absent · not-read"
  }
}
```

A key the schema does not declare, such as a question id inside `answers`, is the
sender's text, so it is shown as `<key 1>`, `<key 2>`, and so on. Schema failures
redact such keys from their paths in the same way.

`--show-values` shows the values too. It is for your own laptop, where the data is
yours to see, so it is refused unless the server is bound to `127.0.0.1` or `::1`:

```bash
RAVN_HOOK_SECRET='<secret>' npx ravn-hook-echo --host 127.0.0.1 --show-values
```

Every viewer response carries `referrer-policy: no-referrer`,
`x-robots-tag: noindex`, `cache-control: no-store`, and a content security policy
that allows this origin only. The page has no Open Graph tags and loads nothing
from anywhere else.

A test fails if any viewer response contains a value from a test packet while
`--show-values` is off. The test packets carry canary strings, which makes the
check a substring search.

## Configuration

| Setting | Default | |
| --- | --- | --- |
| `RAVN_HOOK_SECRET` | none, required | The signing secret Ravn showed when the hook was created |
| `PORT`, `--port` | `8080` | Listen port |
| `HOST`, `--host` | `0.0.0.0` | Bind address |
| `PUBLIC_BASE_URL` | `http://localhost:<port>` | The address Ravn reaches this hook on, used in the printed URLs |
| `VIEW_TOKEN` | random, printed at start | The viewer's token |
| `RETENTION_HOURS` | `24` | How long deliveries stay in memory |
| `--show-values` | off | Show packet values in the viewer. Loopback only |
| `--no-fetch-schema` | off | Use the vendored schema without fetching the published one |

Other endpoints: `GET /healthz` answers `{ "ok": true }`.

## Develop

```bash
pnpm install
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run check:schema-sync   # the vendored schema equals the published one
```

`schema/stage-contract.v1.json` is a byte-for-byte copy of the published schema.
Update it with:

```bash
curl -sSL https://ravnsecurity.io/schema/stage-contract.v1.json -o schema/stage-contract.v1.json
```

Test packets live in `test/fixtures.ts`. They are synthetic, and every value
carries the canary string the no-values test searches for.

## License

[Apache-2.0](LICENSE). Security reports go to security@ravnsecurity.io, see
[SECURITY.md](SECURITY.md).
