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
- [Run it as a service account](#run-it-as-a-service-account)
- [What it does with each delivery](#what-it-does-with-each-delivery)
- [Modes: misbehaving on request](#modes-misbehaving-on-request)
- [What the echo answers](#what-the-echo-answers)
- [The viewer](#the-viewer)
- [Configuration](#configuration)
- [Deploy](#deploy)
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
- A hook may **answer** the stages its program lets it answer. It answers as a
  **service account** the org owns, through Ravn's answer route or its MCP
  server, never in the delivery's HTTP response: Ravn ignores that. Ravn records
  the answer as the stage's output, and the next stage reads it. An answer never
  acts: no decision, no comment, no state change at the source.
- A stage waiting on a hook's answer waits until the program's deadline, then the
  case goes to a person.
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

## Run it as a service account

Without a service account the hook only receives. With one, it also answers
every stage it is sent with its echo output, and after each delivery reads what
Ravn knows about the case over MCP.

1. In Ravn, an org admin opens **Service accounts** and creates one, such as
   *echo*. One service account stands behind one live hook.
2. On the service account, **Get an unwrap token**. It is shown once, works once,
   and expires after 24 hours.
3. On the hook, name the service account, tick the stages it **may answer**, and
   give it the reads. On **Stages**, choose **Wait for its answer** to have the
   next stage wait for it.
4. Run the hook with the unwrap token, and a volume for its state:

```bash
docker run --rm -p 8080:8080 \
  -e RAVN_HOOK_SECRET='<signing secret>' \
  -e RAVN_UNWRAP_TOKEN='<unwrap token>' \
  -v ravn-hook-echo:/home/node/.ravn-hook-echo \
  ravn-hook-echo
```

Or with Node: `RAVN_HOOK_SECRET=… RAVN_UNWRAP_TOKEN=… npx ravn-hook-echo`.

### How it keeps its token

On first start it redeems the unwrap token over Ravn's public GraphQL, the call
the service account page shows:

```bash
curl -s https://apps.ravnsecurity.io/api/gateway/graphql \
  -H 'content-type: application/json' \
  -d "{\"query\":\"mutation(\$t:String!){iam{redeemUnwrap(token:\$t){success code accessToken expiresIn refreshToken refreshExpiresAt}}}\",\"variables\":{\"t\":\"$RAVN_UNWRAP_TOKEN\"}}"
```

That gives an access token, good for 15 minutes, and a refresh token, good for
90 days from its last use.

- The refresh token goes into the state file, `~/.ravn-hook-echo/state.json` by
  default (`RAVN_STATE_FILE`), mode 600. In the container that is the volume above.
- When the access token has under a minute left, or Ravn answers `401`, it calls
  `renew(refreshToken)`. That returns a new access token **and a new refresh
  token**, and the old refresh token is spent. The new one is saved before
  anything else happens.
- A spent refresh token presented again **revokes the whole chain**, because two
  holders of one credential is a leak. So only one renew is ever in flight, and
  two deployments must never share a state file. To move the hook, revoke the
  account's tokens in Ravn and give the new deployment a new unwrap token.
- A restart renews from the state file. The unwrap token is not presented again.
  A different `RAVN_UNWRAP_TOKEN` is noticed and redeemed.
- No token is ever logged, printed or shown in the viewer.

A refusal is a code: `used`, `expired`, `revoked`, `reused`, `suspended`,
`invalid`, `not_allowed`, or `unavailable`. The viewer's header shows it.

For a quick test with an access token you already have, set
`RAVN_ACCESS_TOKEN_ONLY` instead. It is used as is and never renewed, so it stops
working when it expires.

### How it answers

When a delivery is answered `2xx`, the hook answers the stage run the packet
names:

```bash
curl -s https://apps.ravnsecurity.io/api/connect/hooks/v1/answers \
  -H "authorization: Bearer $ACCESS_TOKEN" -H 'content-type: application/json' \
  -d '{"stageRunId": "…", "attempt": 1, "out": { …the stage’s Out… }}'
```

- `stageRunId` and `attempt` are the packet's own. `out` is the
  [echo output](#what-the-echo-answers), checked here against the published
  `<Stage>Answer` before it is sent. Follow-up's `out` is a list: one answer
  carries every release line the hook knows.
- Each stage run is answered once. A retried delivery is the same run.
- Ravn replies `200` with `answer: accepted`, or a problem+json refusal with a
  `code`: `late`, `already_answered`, `superseded`, `not_found`, `not_allowed`,
  `not_bound`, `schema_invalid`, `body_text_refused` or `facts_only`. The contract
  refusals carry `paths`, JSON pointers into `out`.
- `ANSWER_STAGES` limits which stages it answers, such as `classify,route`, or
  `none`. The default is all six. Ravn refuses a stage the hook may not answer
  with `not_allowed`.

The [modes](#modes-misbehaving-on-request) `never`, `answer-late` and
`answer-invalid` change the answer, to show what Ravn does about it.

### What it reads

After each delivered stage run it calls four tools on Ravn's MCP server,
`https://apps.ravnsecurity.io/api/connect/mcp/v1`, with the same access token,
each as of the packet's `asOf`:

| Tool | Asks |
| --- | --- |
| `get_case` | The case, by the packet's `reportId` |
| `get_reporter_facts` | What Ravn knows about the reporter Classify's packet named. Later stages of the same case reuse it. Not asked when no packet named one |
| `find_similar` | Cases with the same fingerprint |
| `lookup_precedents` | Reviewed precedents. Ravn keeps none yet, and says `not-kept` |

The viewer shows each answer's code, such as `3-packets`, `not-observed` or
`too-few`, and how many items each list held. It never shows a value.

`RAVN_URL` points the hook at a Ravn other than `https://apps.ravnsecurity.io`.
The paths under it stay the same.

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
6. **Answer and read**, with a service account, once the response is `2xx`. See
   [Run it as a service account](#run-it-as-a-service-account).

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
| `/assess/never` | `200`, and never answers | Ravn's deadline passes, and the case goes to a person |
| `/assess/answer-late/5m` | `200`, then answers 5 minutes later | A late answer is refused with `late`, not recorded |
| `/assess/answer-invalid` | `200`, then answers with an invalid Out | The refusal, `schema_invalid`, and the paths it names |

The last three change the answer, so they need a
[service account](#run-it-as-a-service-account). The others answer once the
delivery succeeds: `/assess/fail/3` answers after the fourth attempt.

- `fail/<n>` counts attempts with `x-ravn-attempt`. Without that header it counts
  the times it has seen the delivery id.
- `slow/<n>s` and `slow/<n>ms` are both accepted.
- `fail/<n>` is capped at 20 and `slow` at 120 seconds, so a public instance cannot
  be used to hold sockets open.
- `answer-late/<n>` takes `ms`, `s`, `m` or `h`, capped at 24 hours.
- `answer-invalid` drops the Out's first key and adds `echoInvalid`, which the
  schema does not declare.

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

The echo output is what the hook answers with, as a service account. It is also
returned in the delivery's response body as `output`, which Ravn ignores, and
shown in the viewer.

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
and the latency. With a service account it also shows the answer sent, Ravn's
reply code and any paths it refused, and each MCP read's code and counts. Its
header shows the service account's state, and the last refusal code if there
was one.

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
| `RAVN_HOOK_SECRET` | none | The signing secret Ravn showed when the hook was created. Unset, the hook boots **unconfigured**: every delivery is answered `503` and nothing is stored |
| `PORT`, `--port` | `8080` | Listen port |
| `HOST`, `--host` | `0.0.0.0` | Bind address |
| `PUBLIC_BASE_URL` | `http://localhost:<port>` | The address Ravn reaches this hook on, used in the printed URLs |
| `VIEW_TOKEN` | random, printed at start | The viewer's token. Set, it is never printed |
| `RETENTION_HOURS` | `24` | How long deliveries stay in memory |
| `--show-values` | off | Show packet values in the viewer. Loopback only |
| `--no-fetch-schema` | off | Use the vendored schema without fetching the published one |
| `RAVN_UNWRAP_TOKEN` | none | The service account's one-time unwrap token. Set, the hook answers and reads |
| `RAVN_ACCESS_TOKEN_ONLY` | none | Instead, an access token to use as is, never renewed |
| `RAVN_STATE_FILE` | `~/.ravn-hook-echo/state.json` | Where the refresh token is kept, mode 600 |
| `ANSWER_STAGES` | all six | The stages to answer, comma-separated, or `none` |
| `RAVN_URL` | `https://apps.ravnsecurity.io` | Where Ravn is |

Other endpoints: `GET /healthz` answers `{ "ok": true, "configured": true }`, and
`200` even when unconfigured, so a pod waiting for its secret stays up.

### Unconfigured

Without `RAVN_HOOK_SECRET` the hook still starts, so a deployment can come up
before its secret is written:

- Every delivery is answered `503` with the reason, before its body is read.
  Ravn retries it, so nothing is lost.
- The viewer's header says *not configured*.
- Without `VIEW_TOKEN` too, no viewer token is generated for printing:
  there is nothing to see.

Without `RAVN_UNWRAP_TOKEN` and without a state file, it receives only, and the
viewer says answers and reads are off.

### Logs

Nothing the hook prints carries a token, a secret or a value from a packet, so
its logs can be shipped to a log store. The one exception is a viewer token it
generated itself, printed once so you can open the viewer; set `VIEW_TOKEN` and
the printed URL says `#k=<VIEW_TOKEN>` instead. A test runs the real CLI with
marked credentials and canary packets and searches everything it printed.

## Deploy

Ravn runs one instance at `https://echo-hook.ravnsecurity.io`, as `svc-hook-echo`
on the shared service chart:

- `deploy/values.yaml`, `deploy/values-prod.yaml`: one replica, a 1 GiB volume
  at `/state` for the refresh token chain, and the secret
  `ravn/prod/svc-hook-echo/hook` (`RAVN_HOOK_SECRET`, `RAVN_UNWRAP_TOKEN`,
  `VIEW_TOKEN`) through an ExternalSecret, mounted optional so the pod boots
  before it exists. Env is read at start: restart the pod after writing it.
- `.github/workflows/deploy.yml`: on a push to `main`, `ci` then
  `ravn-actions`' deploy workflow, which builds the image to ECR and writes the
  lane record in argo-apps.

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
