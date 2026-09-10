import { describe, it, expect } from "vitest";
import {
  encodeHeaderPayload,
  decodeHeaderPayload,
  HEADER_PAYMENT_REQUIRED,
} from "../../src/headers/codec.js";
import {
  parsePaymentRequired,
  parsePaymentPayload,
  parseSettlementResponse,
} from "../../src/headers/validate.js";
import {
  FIXTURE_REQUIRED,
  FIXTURE_PAYLOAD,
  FIXTURE_SETTLE_OK,
  FIXTURE_REQUIRED_HEADER,
  FIXTURE_SIGNATURE_HEADER,
} from "../fixtures/facilitator.js";

describe("x402 header codec", () => {
  it("round-trips PaymentRequired", () => {
    const encoded = encodeHeaderPayload(FIXTURE_REQUIRED);
    const decoded = decodeHeaderPayload(encoded, parsePaymentRequired);
    expect(decoded).toEqual(FIXTURE_REQUIRED);
    expect(HEADER_PAYMENT_REQUIRED).toBe("PAYMENT-REQUIRED");
  });

  it("round-trips PaymentPayload", () => {
    const decoded = decodeHeaderPayload(
      FIXTURE_SIGNATURE_HEADER,
      parsePaymentPayload,
    );
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted.amount).toBe(FIXTURE_PAYLOAD.accepted.amount);
  });

  it("parses SettlementResponse", () => {
    const encoded = encodeHeaderPayload(FIXTURE_SETTLE_OK);
    const decoded = decodeHeaderPayload(encoded, parseSettlementResponse);
    expect(decoded.success).toBe(true);
    expect(decoded.transaction.startsWith("0x")).toBe(true);
  });

  it("decodes canonical fixture header", () => {
    const decoded = decodeHeaderPayload(
      FIXTURE_REQUIRED_HEADER,
      parsePaymentRequired,
    );
    expect(decoded.accepts[0]?.network).toBe("eip155:84532");
  });
});
