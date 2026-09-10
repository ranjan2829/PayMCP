const SIGNATURE_HEADER_RE = /PAYMENT-SIGNATURE\s*[:=]?\s*["']?[A-Za-z0-9+/=_-]{20,}["']?/gi;
const LONG_B64_RE = /\b[A-Za-z0-9+/]{80,}={0,2}\b/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._\-]+/gi;

/** Redact payment signatures and long base64 blobs from log/error strings. */
export function redactPaymentSignature(input: string): string {
  return input
    .replace(SIGNATURE_HEADER_RE, "PAYMENT-SIGNATURE=[REDACTED]")
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(LONG_B64_RE, "[REDACTED_B64]");
}

/** Safe summary of a payment signature header for structured logs. */
export function summarizePaymentSignatureHeader(
  header: string | undefined,
): { present: boolean; length: number; sha256Prefix?: string } {
  if (header === undefined || header.length === 0) {
    return { present: false, length: 0 };
  }
  return { present: true, length: header.length };
}
