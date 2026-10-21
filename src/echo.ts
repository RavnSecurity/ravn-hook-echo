import { createHash } from "node:crypto";
import type { HookableStage } from "./stages.js";

/**
 * The echo output: a schema-valid output for the stage, derived from the
 * delivery's `inputDigest` and nothing else. The same input always gets the
 * same answer, and no value from the packet ever reaches the output, so the
 * output is safe to show in the viewer.
 *
 * Ravn ignores the output today (a hook only receives until ravn-product#46).
 * It is returned in the response body and shown in the viewer so that the day
 * the return path lands, this hook is already a drop-in. Every field is
 * documented in the README under "What the echo answers".
 */

export const ECHO_TOOL = "ravn-hook-echo";

export interface EchoSeed {
  /** `inputDigest` when the delivery carried a well-formed one, else the sha256 of the raw body. */
  kind: "inputDigest" | "body-sha256";
  digest: string;
}

export function seedOf(body: Buffer, inputDigest: unknown): EchoSeed {
  if (typeof inputDigest === "string" && /^[0-9a-f]{64}$/.test(inputDigest)) {
    return { kind: "inputDigest", digest: inputDigest };
  }
  return { kind: "body-sha256", digest: createHash("sha256").update(body).digest("hex") };
}

const SEVERITIES = ["critical", "high", "medium", "low", "none"] as const;
const CATEGORIES = [
  "injection",
  "broken-auth",
  "xss",
  "misconfiguration",
  "information-disclosure",
  "ssrf",
  "access-control",
  "other",
] as const;
const CWES = ["CWE-79", "CWE-89", "CWE-287", "CWE-352", "CWE-22", "CWE-200", "CWE-502", "CWE-918"];
const ACTIONS = ["auto-close", "escalate"] as const;
const TRACKS = ["light", "standard", "deep"] as const;
const PROPOSALS = ["accept", "reject", "needs-info", "duplicate"] as const;
const OUTCOMES = ["ACCEPTED", "REJECTED", "PENDING"] as const;
const FOLLOW_UP_EVENTS = ["shipped", "not-affected", "wont-fix"] as const;
const SCOPES = ["program", "foundation"] as const;

/** Byte `i` (0–31) of the digest. */
function byte(digest: string, i: number): number {
  return Number.parseInt(digest.slice(2 * i, 2 * i + 2), 16);
}

function pick<T>(digest: string, i: number, options: readonly T[]): T {
  const v = options[byte(digest, i) % options.length];
  if (v === undefined) throw new Error("empty option list");
  return v;
}

/** 0–1, two decimals. */
function unit(digest: string, i: number): number {
  return Math.round((byte(digest, i) / 255) * 100) / 100;
}

/** A fixed instant per digest: 2020-01-01Z plus up to ~4 years of seconds from bytes 28–31. */
function instant(digest: string): string {
  const seconds = Number.parseInt(digest.slice(56, 64), 16) % 126_230_400;
  return new Date(Date.UTC(2020, 0, 1) + seconds * 1000).toISOString();
}

const present = <T>(value: T) => ({ value });
const absent = (reason: string) => ({ value: null, reason });

export function echoOutput(
  stage: HookableStage,
  digest: string,
  version: string,
): Record<string, unknown> {
  switch (stage) {
    case "classify":
      return {
        verdict: {
          isSecurityRelevant: present(byte(digest, 0) % 2 === 1),
          severity: present(pick(digest, 1, SEVERITIES)),
          category: present(`echo.${pick(digest, 2, CATEGORIES)}`),
          isLikelyAiSlop: present(byte(digest, 3) < 32),
          hasPoc: present(byte(digest, 4) % 2 === 0),
          confidence: present(unit(digest, 5)),
          weaknesses: present([{ cwe: pick(digest, 6, CWES), label: "echo" }]),
          products: absent("not-observed"),
          duplicateOf: absent("not-observed"),
        },
        answers: present({
          "echo.is-security-relevant": { p: unit(digest, 7) },
          "echo.has-poc": { p: unit(digest, 8) },
        }),
        ranBy: { model: present(ECHO_TOOL), version },
      };
    case "route":
      return {
        action: pick(digest, 0, ACTIONS),
        reasons: present([`echo.digest-${digest.slice(0, 8)}`]),
        track: present(pick(digest, 1, TRACKS)),
      };
    case "assess":
      return {
        proposed: present(pick(digest, 0, PROPOSALS)),
        severity: present(pick(digest, 1, SEVERITIES)),
        ranBy: { tool: ECHO_TOOL, version },
        card: present(`echo: input digest ${digest.slice(0, 16)}`),
      };
    case "review":
      return {
        outcome: pick(digest, 0, OUTCOMES),
        decidedAt: instant(digest),
        actor: ECHO_TOOL,
        override: absent("not-observed"),
      };
    case "follow-up":
      return {
        line: `echo/${digest.slice(0, 8)}`,
        event: pick(digest, 0, FOLLOW_UP_EVENTS),
        ref: present(`echo:${digest.slice(0, 16)}`),
        at: instant(digest),
      };
    case "knowledge":
      return {
        precedentId: `echo-${digest.slice(0, 16)}`,
        scope: pick(digest, 0, SCOPES),
        reviewer: absent("not-observed"),
      };
  }
}
