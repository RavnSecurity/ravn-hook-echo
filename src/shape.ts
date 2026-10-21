/**
 * The shape of a packet, with no value in it.
 *
 * Titles, URLs, external refs, handles, ids and facts can identify a
 * vulnerability or a person even though the packet carries no report body, so
 * the viewer shows each key, its JSON type, and for a `Maybe` whether it is
 * present or why it is empty:
 *
 *   title:  "string · redacted"
 *   handle: "absent · not-observed"
 *
 * A present Maybe holding an object or array shows that object's shape under
 * `value`, so a nested output (Route's answer inside Assess's packet) reads too.
 *
 * Keys are shown only when the schema declares them. Any other key is text the
 * sender chose (a question id, a parameter name, a stray field), so it shows as
 * `<key 1>`, `<key 2>`, … in order.
 */
export type Shape = string | Shape[] | { [key: string]: Shape };

const EMPTY_REASONS = new Set([
  "not-run",
  "not-observed",
  "unavailable",
  "not-kept",
  "not-declared",
  "not-configured",
  "not-read",
  "too-few",
  "not-filed",
  "not-proposed",
]);

export function shapeOf(value: unknown, knownKeys: ReadonlySet<string>): Shape {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "array[0]";
    const first = value[0];
    if (first === null || typeof first !== "object") {
      return `array[${value.length}] · ${typeOf(first)}`;
    }
    return { [`array[${value.length}]`]: shapeOf(first, knownKeys) };
  }
  if (typeof value !== "object") return `${typeOf(value)} · redacted`;

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (isMaybe(obj, keys)) {
    if (obj.value === null) return `absent · ${String(obj.reason)}`;
    const inner = obj.value;
    if (inner !== null && typeof inner === "object") return { value: shapeOf(inner, knownKeys) };
    return `${typeOf(inner)} · redacted`;
  }
  const out: { [key: string]: Shape } = {};
  let unknown = 0;
  for (const k of keys.sort()) {
    const label = knownKeys.has(k) ? k : `<key ${++unknown}>`;
    out[label] = shapeOf(obj[k], knownKeys);
  }
  return out;
}

function isMaybe(obj: Record<string, unknown>, keys: string[]): boolean {
  if (!keys.includes("value")) return false;
  if (keys.length === 1) return true;
  return (
    keys.length === 2 &&
    keys.includes("reason") &&
    obj.value === null &&
    typeof obj.reason === "string" &&
    EMPTY_REASONS.has(obj.reason)
  );
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
