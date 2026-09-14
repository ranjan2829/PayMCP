import { createHmac } from "node:crypto";

/**
 * Visa Developer X-Pay Token (API Key + Shared Secret).
 * @see https://developer.visa.com/pages/working-with-visa-apis/x-pay-token
 *
 * XPayToken = "xv2:" + timestamp + ":" + HMAC-SHA256(shared_secret, timestamp + resource_path + query_string + body)
 * Shared secret and API key MUST come from operator env — never hardcode.
 */
export function buildXPayToken(args: {
  readonly sharedSecret: string;
  readonly timestampSeconds: number;
  /** Resource path without host, e.g. /vic/v1/payments/settle */
  readonly resourcePath: string;
  /** Query string WITHOUT leading ?, params lexicographically sorted by Visa rules. */
  readonly queryString?: string;
  readonly body?: string;
}): string {
  if (args.sharedSecret.trim().length === 0) {
    throw new Error("X-Pay shared secret is required");
  }
  const message =
    String(args.timestampSeconds) +
    args.resourcePath +
    (args.queryString ?? "") +
    (args.body ?? "");
  const digest = createHmac("sha256", args.sharedSecret)
    .update(message, "utf8")
    .digest("hex");
  return `xv2:${args.timestampSeconds}:${digest}`;
}

/** Sort query params and encode as Visa expects for X-Pay (no leading ?). */
export function canonicalizeQuery(
  params: Readonly<Record<string, string>>,
): string {
  const keys = Object.keys(params).sort();
  return keys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!)}`)
    .join("&");
}
