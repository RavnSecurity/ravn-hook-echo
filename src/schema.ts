import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { ENVELOPE_DEF, type HookableStage, OUT_DEF } from "./stages.js";

/** The stage contract's one stable name. The vendored copy is a fallback for the same bytes. */
export const SCHEMA_ID = "https://ravnsecurity.io/schema/stage-contract.v1.json";

export const VENDORED_SCHEMA_URL = new URL("../../schema/stage-contract.v1.json", import.meta.url);

export interface SchemaSource {
  kind: "vendored" | "published";
  /** When the published copy was fetched. Absent for the vendored one. */
  fetchedAt?: string;
}

/**
 * One failing JSON path. Never a value: the message is the validator's
 * (a keyword and, for a missing or extra key, that key's name), and the path
 * is a JSON pointer into the delivery.
 */
export interface SchemaFailure {
  path: string;
  keyword: string;
  message: string;
}

export interface SchemaVerdict {
  valid: boolean;
  failures: SchemaFailure[];
}

export function loadVendoredSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync(VENDORED_SCHEMA_URL, "utf8")) as Record<string, unknown>;
}

/**
 * The published schema, from its `$id`, or null when it is not there yet or is
 * not the schema (a sign-in page behind a redirect, for one). The caller falls
 * back to the vendored copy and says so.
 */
export async function fetchPublishedSchema(
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Record<string, unknown> | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(SCHEMA_ID, {
      redirect: "follow",
      headers: { accept: "application/schema+json, application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return null;
    }
    if (!doc || typeof doc !== "object" || (doc as { $id?: unknown }).$id !== SCHEMA_ID) {
      return null;
    }
    return doc as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The stage contract, compiled once, asked per stage. */
export class StageSchema {
  readonly source: SchemaSource;
  /** Every property name the schema declares. Any other key is the sender's text, and is redacted. */
  readonly knownKeys: ReadonlySet<string>;
  private readonly ajv: Ajv2020;
  private readonly compiled = new Map<string, ValidateFunction>();

  constructor(doc: Record<string, unknown>, source: SchemaSource) {
    this.source = source;
    this.ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
    addFormats.default(this.ajv);
    this.ajv.addSchema(doc, SCHEMA_ID);
    this.knownKeys = collectKeys(doc);
  }

  /** The envelope Ravn sends for a stage. */
  validateEnvelope(stage: HookableStage, value: unknown): SchemaVerdict {
    return this.validateDef(ENVELOPE_DEF[stage], value);
  }

  /** The output a hook would answer with for a stage. */
  validateOutput(stage: HookableStage, value: unknown): SchemaVerdict {
    return this.validateDef(OUT_DEF[stage], value);
  }

  validateDef(def: string, value: unknown): SchemaVerdict {
    const validate = this.compile(def);
    const valid = validate(value) as boolean;
    return {
      valid,
      failures: valid ? [] : failuresOf(validate.errors ?? [], this.knownKeys),
    };
  }

  private compile(def: string): ValidateFunction {
    let v = this.compiled.get(def);
    if (!v) {
      v = this.ajv.compile({ $ref: `${SCHEMA_ID}#/$defs/${def}` });
      this.compiled.set(def, v);
    }
    return v;
  }
}

/**
 * Ajv's errors, by path and keyword, with the noise of a `oneOf` collapsed:
 * one line per distinct path and keyword, deepest paths first so the real
 * failure reads before the branches it made fail.
 */
export function failuresOf(errors: ErrorObject[], knownKeys: ReadonlySet<string>): SchemaFailure[] {
  const seen = new Set<string>();
  const out: SchemaFailure[] = [];
  for (const e of errors) {
    const path = redactPath(e.instancePath, knownKeys);
    const key = `${path} ${e.keyword}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, keyword: e.keyword, message: messageOf(e, knownKeys) });
  }
  return out.sort((a, b) => depth(b.path) - depth(a.path) || a.path.localeCompare(b.path));
}

function depth(path: string): number {
  return path === "/" ? 0 : path.split("/").length - 1;
}

/** The validator's message, which names keywords and key names, never a value. */
function messageOf(e: ErrorObject, knownKeys: ReadonlySet<string>): string {
  switch (e.keyword) {
    case "required":
      return `missing key: ${String((e.params as { missingProperty?: string }).missingProperty)}`;
    case "additionalProperties": {
      const key = String((e.params as { additionalProperty?: string }).additionalProperty);
      return knownKeys.has(key) ? `unexpected key: ${key}` : "unexpected key (not in the schema)";
    }
    case "enum":
      return "not one of the allowed values";
    case "const":
      return "not the required constant";
    case "oneOf":
      return "matches none of the alternatives, or more than one";
    case "anyOf":
      return "matches none of the alternatives";
    case "type":
      return `wrong type: expected ${String((e.params as { type?: string }).type)}`;
    default:
      return e.message ?? e.keyword;
  }
}

/** A JSON pointer with every segment the schema does not declare replaced by `<key>`. Indexes stay. */
export function redactPath(pointer: string, knownKeys: ReadonlySet<string>): string {
  if (!pointer) return "/";
  return pointer
    .split("/")
    .map((seg, i) => {
      if (i === 0) return seg;
      const key = seg.replace(/~1/g, "/").replace(/~0/g, "~");
      return /^\d+$/.test(key) || knownKeys.has(key) ? seg : "<key>";
    })
    .join("/");
}

/** Every name under a `properties` keyword, anywhere in the document. */
export function collectKeys(doc: unknown): Set<string> {
  const keys = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "properties" && v && typeof v === "object") {
        for (const name of Object.keys(v as object)) keys.add(name);
      }
      walk(v);
    }
  };
  walk(doc);
  return keys;
}
