/**
 * The viewer: "if you have the URL, you can see what the hook did".
 *
 * The token travels in the URL fragment (`/view#k=<token>`). A fragment is
 * never sent to a server, so it stays out of access logs, proxies, `Referer`
 * and link unfurlers. The page's script reads it and calls `/api/deliveries`
 * with `authorization: Bearer <token>`.
 *
 * The script and the stylesheet are their own routes so the CSP can be
 * `'self'` only, with nothing inline and no third-party origin.
 */

export const VIEWER_HEADERS: Record<string, string> = {
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export const VIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>ravn-hook-echo</title>
<link rel="stylesheet" href="view.css">
</head>
<body>
<header>
  <h1>ravn-hook-echo</h1>
  <p id="status">Loading…</p>
</header>
<main>
  <section id="meta" hidden></section>
  <section id="empty" hidden><p>No deliveries yet. Point a program's stage at this hook and send it a case.</p></section>
  <section id="list"></section>
</main>
<script src="view.js"></script>
</body>
</html>
`;

export const VIEW_CSS = `:root { color-scheme: light dark; --fg: #1b1b1f; --bg: #fff; --muted: #6b6f76; --line: #e3e5e8; --ok: #1a7f37; --bad: #b42318; --warn: #9a6700; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e6e9; --bg: #121316; --muted: #9a9ea6; --line: #2a2d33; --ok: #3fb950; --bad: #f85149; --warn: #d29922; } }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: var(--fg); background: var(--bg); }
header, main { max-width: 1100px; margin: 0 auto; padding: 0 16px; }
header { padding-top: 24px; }
h1 { font-size: 20px; margin: 0 0 4px; }
#status, #meta { color: var(--muted); font-size: 13px; }
#meta { margin: 8px 0 16px; }
#meta span + span::before { content: " · "; }
details.d { border: 1px solid var(--line); border-radius: 8px; margin: 10px 0; }
details.d > summary { list-style: none; cursor: pointer; display: grid; grid-template-columns: 1.4fr 1fr 2fr 1fr 1fr; gap: 8px; padding: 10px 12px; align-items: center; font-size: 14px; }
details.d > summary::-webkit-details-marker { display: none; }
details.d > summary .t { color: var(--muted); font-size: 12px; }
details.d > summary code { font-family: var(--mono); font-size: 12px; }
.b { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 12px; border: 1px solid var(--line); white-space: nowrap; }
.ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--warn); }
.body { padding: 0 12px 12px; border-top: 1px solid var(--line); }
.body h3 { font-size: 13px; margin: 14px 0 4px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .02em; }
pre { font-family: var(--mono); font-size: 12px; line-height: 1.45; margin: 0; padding: 10px; border-radius: 6px; background: rgba(127,127,127,.08); overflow: auto; white-space: pre-wrap; word-break: break-word; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 0; font-size: 13px; }
dt { color: var(--muted); } dd { margin: 0; font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
ul.fail { margin: 0; padding-left: 18px; font-family: var(--mono); font-size: 12px; }
@media (max-width: 720px) { details.d > summary { grid-template-columns: 1fr 1fr; } }
`;

export const VIEW_JS = `(function () {
  "use strict";
  var statusEl = document.getElementById("status");
  var metaEl = document.getElementById("meta");
  var listEl = document.getElementById("list");
  var emptyEl = document.getElementById("empty");

  function token() {
    var h = location.hash.replace(/^#/, "");
    var m = /(?:^|&)k=([^&]*)/.exec(h);
    return m ? decodeURIComponent(m[1]) : "";
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function badge(text, cls) { return el("span", "b " + (cls || ""), text); }
  function pretty(v) { return JSON.stringify(v, null, 2); }
  function row(dl, k, v) { dl.appendChild(el("dt", null, k)); dl.appendChild(el("dd", null, v)); }

  function render(data) {
    metaEl.hidden = false;
    metaEl.textContent = "";
    metaEl.appendChild(el("span", null, "schema: " + data.schema.source + " (" + data.schema.id + ")"));
    metaEl.appendChild(el("span", null, "retention: " + data.retentionHours + "h"));
    metaEl.appendChild(el("span", null, data.showValues ? "values: shown (--show-values)" : "values: shape only"));
    metaEl.appendChild(el("span", null, "refreshes every 5s"));

    var open = {};
    listEl.querySelectorAll("details[open]").forEach(function (d) { open[d.dataset.seq] = true; });
    listEl.textContent = "";
    emptyEl.hidden = data.deliveries.length > 0;

    data.deliveries.forEach(function (d) {
      var det = el("details", "d");
      det.dataset.seq = d.seq;
      if (open[d.seq]) det.open = true;
      var sum = el("summary");
      var c1 = el("div");
      c1.appendChild(el("div", null, (d.stage || "?") + " · " + d.mode));
      c1.appendChild(el("div", "t", d.receivedAt));
      sum.appendChild(c1);
      var c2 = el("div");
      c2.appendChild(badge(d.response.status, d.response.status < 300 ? "ok" : "bad"));
      c2.appendChild(document.createTextNode(" " + d.latencyMs + "ms"));
      sum.appendChild(c2);
      var c3 = el("div");
      var code = el("code", null, d.deliveryId || "(no x-ravn-delivery)");
      c3.appendChild(code);
      c3.appendChild(el("div", "t", "attempt " + (d.attempt === null ? "?" : d.attempt) + (d.duplicate ? " · retry (seen " + d.seen + "×)" : "")));
      sum.appendChild(c3);
      var c4 = el("div");
      c4.appendChild(badge("signature ok", "ok"));
      sum.appendChild(c4);
      var c5 = el("div");
      if (d.schemaValid === true) c5.appendChild(badge("schema ok", "ok"));
      else if (d.schemaValid === false) c5.appendChild(badge("schema: " + d.schemaFailures.length + " path" + (d.schemaFailures.length === 1 ? "" : "s"), "bad"));
      else c5.appendChild(badge("not JSON", "bad"));
      sum.appendChild(c5);
      det.appendChild(sum);

      var body = el("div", "body");
      body.appendChild(el("h3", null, "Delivery"));
      var dl = el("dl");
      row(dl, "stage", d.stage || "(none)");
      row(dl, "event", d.event || "(no x-ravn-event)");
      row(dl, "path", d.path);
      row(dl, "mode", d.mode);
      row(dl, "delivery id", d.deliveryId || "(none)");
      row(dl, "attempt", d.attempt === null ? "(no x-ravn-attempt)" : d.attempt);
      row(dl, "seen", d.seen + "×" + (d.duplicate ? " (a retry of a delivery already received)" : ""));
      row(dl, "received at", d.receivedAt);
      row(dl, "signature", "valid");
      row(dl, "schema", d.schemaValid === true ? "valid" : d.schemaValid === false ? "invalid" : "body did not parse: " + d.parseError);
      row(dl, "inputDigest", d.inputDigest || "(none)");
      if (d.seed) row(dl, "echo seed", d.seed.kind + " " + d.seed.digest);
      row(dl, "response", d.response.status + " · " + d.response.note);
      row(dl, "latency", d.latencyMs + "ms");
      body.appendChild(dl);

      if (d.schemaFailures && d.schemaFailures.length) {
        body.appendChild(el("h3", null, "Failing paths"));
        var ul = el("ul", "fail");
        d.schemaFailures.forEach(function (f) { ul.appendChild(el("li", null, f.path + " — " + f.keyword + ": " + f.message)); });
        body.appendChild(ul);
      }
      if (d.echo) {
        body.appendChild(el("h3", null, "Echo output (what this hook would answer)"));
        body.appendChild(el("pre", null, pretty(d.echo)));
      }
      if (d.shape) {
        body.appendChild(el("h3", null, data.showValues ? "Packet shape" : "Packet shape (values are never shown here)"));
        body.appendChild(el("pre", null, pretty(d.shape)));
      }
      if (data.showValues && d.body !== undefined) {
        body.appendChild(el("h3", null, "Packet (--show-values)"));
        body.appendChild(el("pre", null, pretty(d.body)));
      }
      det.appendChild(body);
      listEl.appendChild(det);
    });
  }

  function load() {
    var k = token();
    if (!k) {
      statusEl.textContent = "No token. Open the URL printed when the hook started: /view#k=<token>.";
      return;
    }
    fetch("api/deliveries", { headers: { authorization: "Bearer " + k }, cache: "no-store" })
      .then(function (r) {
        if (r.status === 401) throw new Error("That token is not this hook's. Open the URL printed when it started.");
        if (!r.ok) throw new Error("The hook answered " + r.status + ".");
        return r.json();
      })
      .then(function (data) {
        statusEl.textContent = data.deliveries.length + " deliver" + (data.deliveries.length === 1 ? "y" : "ies") + " in the last " + data.retentionHours + "h";
        render(data);
      })
      .catch(function (e) { statusEl.textContent = e.message; });
  }
  load();
  setInterval(load, 5000);
  window.addEventListener("hashchange", load);
})();
`;
