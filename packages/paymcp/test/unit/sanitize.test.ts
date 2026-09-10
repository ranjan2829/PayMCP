import { describe, it, expect } from "vitest";
import { redactPaymentSignature } from "../../src/http/sanitize.js";

describe("redactPaymentSignature", () => {
  it("redacts long base64 blobs", () => {
    const b64 = "A".repeat(100);
    expect(redactPaymentSignature(`sig=${b64}`)).toContain("[REDACTED_B64]");
    expect(redactPaymentSignature(`sig=${b64}`)).not.toContain(b64);
  });

  it("redacts bearer tokens", () => {
    const out = redactPaymentSignature("Authorization: Bearer abc.def.ghi");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("abc.def.ghi");
  });
});
