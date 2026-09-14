import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  StripeFundingClient,
  creditsForUsdCents,
  verifyStripeSignature,
} from "../src/funding/stripe.js";
import { StoreError } from "../src/errors/index.js";

describe("creditsForUsdCents", () => {
  it("maps $1.00 to 1_000_000 atomic", () => {
    expect(creditsForUsdCents(100)).toBe("1000000");
  });
});

describe("verifyStripeSignature", () => {
  it("accepts a valid signature", () => {
    const secret = "whsec_test_secret_value";
    const body = '{"type":"checkout.session.completed"}';
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", secret)
      .update(`${t}.${body}`, "utf8")
      .digest("hex");
    expect(() =>
      verifyStripeSignature(body, `t=${t},v1=${v1}`, secret),
    ).not.toThrow();
  });

  it("rejects tampered body", () => {
    const secret = "whsec_test_secret_value";
    const body = '{"type":"checkout.session.completed"}';
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", secret)
      .update(`${t}.${body}`, "utf8")
      .digest("hex");
    expect(() =>
      verifyStripeSignature(body + "x", `t=${t},v1=${v1}`, secret),
    ).toThrow(StoreError);
  });
});

describe("StripeFundingClient.parseVerifiedWebhook", () => {
  it("credits from checkout.session.completed", () => {
    const secret = "whsec_test_secret_value";
    const client = new StripeFundingClient({
      secretKey: "sk_live_placeholder_not_used",
      webhookSecret: secret,
      fetchImpl: vi.fn(),
    });
    const session = {
      id: "cs_test_123",
      payment_status: "paid",
      metadata: {
        purpose: "paymcp_store_credits",
        buyerId: "buyer_a",
        creditAmount: "2500000",
      },
    };
    const body = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: session },
    });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", secret)
      .update(`${t}.${body}`, "utf8")
      .digest("hex");
    const result = client.parseVerifiedWebhook(body, `t=${t},v1=${v1}`);
    expect(result).toEqual({
      buyerId: "buyer_a",
      creditAmount: "2500000",
      fundingId: "stripe:cs_test_123",
    });
  });
});
