import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * How a hook knows a delivery came from Ravn.
 *
 * `x-ravn-signature: sha256=<hex>` is an HMAC-SHA256 over the raw body bytes
 * with the signing secret Ravn shows once when the hook is created. It is the
 * same scheme GitHub and HackerOne use for their webhooks, so any example of
 * verifying one of those verifies a Ravn delivery too.
 *
 * The signature covers the body and nothing else. Replay is handled by the
 * payload: a retry of one delivery is byte-identical to the first attempt and
 * carries the same `x-ravn-delivery`, which is the key to dedupe on.
 */
export const SIGNATURE_HEADER = "x-ravn-signature";
export const EVENT_HEADER = "x-ravn-event";
export const DELIVERY_HEADER = "x-ravn-delivery";
export const ATTEMPT_HEADER = "x-ravn-attempt";

/** `sha256=<hex>` over the exact bytes to be sent. Used by the tests and the README's examples. */
export function signBody(body: string | Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * Constant-time verification. The digest alone is compared, after a length
 * check: `timingSafeEqual` throws on a length mismatch rather than returning
 * false, and a sender's capitalisation of the hex must not matter.
 */
export function verifySignature(body: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const marker = header.indexOf("=");
  if (marker === -1) return false;
  const scheme = header.slice(0, marker).trim().toLowerCase();
  if (scheme !== "sha256") return false;
  const provided = Buffer.from(
    header
      .slice(marker + 1)
      .trim()
      .toLowerCase(),
    "utf8",
  );
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"), "utf8");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
