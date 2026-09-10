/**
 * x402 V2 HTTP header codec: base64 JSON for
 * PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE.
 */

export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";
export const HEADER_IDEMPOTENCY_KEY = "Idempotency-Key";

export function encodeHeaderPayload(value: unknown): string {
  const json = JSON.stringify(value);
  return Buffer.from(json, "utf8").toString("base64");
}

export function decodeHeaderPayload<T>(
  headerValue: string,
  validate: (raw: unknown) => T,
): T {
  let json: string;
  try {
    json = Buffer.from(headerValue, "base64").toString("utf8");
  } catch {
    throw new HeaderDecodeError("header is not valid base64");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch {
    throw new HeaderDecodeError("header base64 does not decode to JSON");
  }
  return validate(raw);
}

export class HeaderDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeaderDecodeError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
