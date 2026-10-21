import { createHash } from "node:crypto";
import type { HookableStage } from "../src/stages.js";

/**
 * Synthetic packets, one per stage a hook can serve. Every free-text value
 * carries a canary, so "the viewer shows no value" is a substring search.
 * Nothing here is real: the ids, refs and URLs are made up for the tests.
 */
export const CANARY = "CANARY7f3a";
const c = (label: string) => `${CANARY}-${label}`;

/** Canonical JSON (object keys sorted, arrays as they are), as Ravn digests a packet. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function digestOf(packet: unknown): string {
  return createHash("sha256").update(canonical(packet), "utf8").digest("hex");
}

const v = <T>(value: T) => ({ value });
const none = (reason: string) => ({ value: null, reason });

const classifyOut = {
  verdict: {
    isSecurityRelevant: v(true),
    severity: v("high"),
    category: v(c("category")),
    isLikelyAiSlop: v(false),
    hasPoc: v(true),
    confidence: v(0.8),
    weaknesses: v([{ cwe: c("cwe"), label: c("cwe-label") }]),
    products: v([c("product")]),
    duplicateOf: none("not-observed"),
  },
  answers: v({ "q.example": { p: 0.4 } }),
  ranBy: { model: v(c("model")), version: c("model-version") },
};

const routeOut = {
  action: "escalate",
  reasons: v(["rule.example"]),
  track: v("standard"),
};

const assessOut = {
  proposed: v("accept"),
  severity: v("medium"),
  ranBy: { tool: c("tool"), version: c("tool-version") },
  card: v(c("card")),
};

const reviewOut = {
  outcome: "ACCEPTED",
  decidedAt: "2026-01-02T03:04:05.000Z",
  actor: c("actor"),
  override: none("not-observed"),
};

export const PACKETS: Record<HookableStage, Record<string, unknown>> = {
  classify: {
    report: {
      source: c("source"),
      externalRef: c("external-ref"),
      url: v(`https://example.invalid/${c("url")}`),
      title: v(c("title")),
      account: v({ source: c("acct-source"), externalId: c("acct-id"), handle: c("handle") }),
      observedAt: "2026-01-01T00:00:00.000Z",
    },
    questionSetVersion: v(c("qset")),
    bodyAccess: none("not-read"),
  },
  route: {
    classify: v(classifyOut),
    reporter: { accepted: v(3), decided: none("not-observed") },
    answers: v({ "q.example": { p: 0.25 } }),
    params: v({ floor: c("param") }),
  },
  assess: {
    route: v(routeOut),
    answers: none("not-run"),
    filed: {
      severity: v("high"),
      cvss: v(7.5),
      weakness: v({ cwe: c("filed-cwe"), label: c("filed-label") }),
      asset: v(c("asset")),
    },
    reporter: v({
      minTrustClass: "VERIFIED",
      facts: [
        { fact: c("fact"), value: c("fact-value"), trust: "VERIFIED" },
        { fact: c("fact-2"), value: null, reason: "not-observed" },
      ],
    }),
    similar: v({
      thisProgram: v([
        { reportId: c("similar-id"), externalRef: c("similar-ref"), outcome: "accepted" },
      ]),
      otherPrograms: none("too-few"),
      basis: "fingerprint-equal",
    }),
    precedents: none("not-kept"),
  },
  review: {
    route: v(routeOut),
    assess: v(assessOut),
  },
  "follow-up": {
    review: reviewOut,
    lines: v([c("line")]),
  },
  knowledge: {
    review: reviewOut,
  },
};

export function envelope(stage: HookableStage, overrides: Record<string, unknown> = {}) {
  const packet = PACKETS[stage];
  return {
    contract: 1,
    stage,
    stageRunId: c(`run-${stage}`),
    attempt: 1,
    reportId: c("report"),
    source: c("source"),
    externalRef: c("external-ref"),
    url: `https://example.invalid/${c("envelope-url")}`,
    orgId: c("org"),
    programId: c("program"),
    stageSettingsVersionId: c("settings"),
    // The schema's v1 word for a hook's Impl is "plug"; it is the published contract, kept as is.
    impl: { kind: "plug", plugId: c("hook-id") },
    asOf: "2026-01-01T00:00:00.000Z",
    inputDigest: digestOf(packet),
    packet,
    ...overrides,
  };
}
