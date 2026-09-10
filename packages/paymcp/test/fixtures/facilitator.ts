import {
  X402_VERSION,
  type PaymentAccept,
  type PaymentPayload,
  type PaymentRequired,
  type SettlementResponse,
} from "../../src/types/x402.js";
import { encodeHeaderPayload } from "../../src/headers/codec.js";

export const FIXTURE_ACCEPT: PaymentAccept = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};

export const FIXTURE_RESOURCE = {
  url: "http://127.0.0.1:8787/echo",
  description: "Echo one JSON payload",
  mimeType: "application/json",
};

export const FIXTURE_REQUIRED: PaymentRequired = {
  x402Version: X402_VERSION,
  error: "PAYMENT-SIGNATURE header is required",
  resource: FIXTURE_RESOURCE,
  accepts: [FIXTURE_ACCEPT],
};

export const FIXTURE_PAYLOAD: PaymentPayload = {
  x402Version: X402_VERSION,
  resource: FIXTURE_RESOURCE,
  accepted: FIXTURE_ACCEPT,
  payload: {
    signature:
      "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c",
    authorization: {
      from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      to: FIXTURE_ACCEPT.payTo,
      value: FIXTURE_ACCEPT.amount,
      validAfter: "1740672089",
      validBefore: "1740672154",
      nonce:
        "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480",
    },
  },
};

export const FIXTURE_SETTLE_OK: SettlementResponse = {
  success: true,
  transaction:
    "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  network: FIXTURE_ACCEPT.network,
  payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
};

export const FIXTURE_SETTLE_FAIL: SettlementResponse = {
  success: false,
  transaction: "",
  network: FIXTURE_ACCEPT.network,
  payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  errorReason: "insufficient_funds",
};

export const FIXTURE_SIGNATURE_HEADER = encodeHeaderPayload(FIXTURE_PAYLOAD);
export const FIXTURE_REQUIRED_HEADER = encodeHeaderPayload(FIXTURE_REQUIRED);

/**
 * Test-only fetch double that speaks the real facilitator /verify + /settle
 * JSON shapes recorded from the x402 HTTP transport. Not a product fake mode.
 */
export function createFacilitatorFixtureFetch(behavior: {
  readonly verifyValid?: boolean;
  readonly settle?: SettlementResponse;
  readonly failTransport?: boolean;
}): typeof fetch {
  const verifyValid = behavior.verifyValid ?? true;
  const settle = behavior.settle ?? FIXTURE_SETTLE_OK;

  const impl: typeof fetch = async (input, init) => {
    if (behavior.failTransport) {
      throw new TypeError("network down");
    }
    const url = typeof input === "string" ? input : input.toString();
    if (init?.method !== "POST") {
      return new Response(JSON.stringify({ error: "method" }), { status: 405 });
    }
    if (url.endsWith("/verify")) {
      return new Response(
        JSON.stringify({
          isValid: verifyValid,
          ...(verifyValid
            ? { payer: FIXTURE_SETTLE_OK.payer }
            : { invalidReason: "invalid_signature", payer: "" }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/settle")) {
      return new Response(JSON.stringify(settle), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  };
  return impl;
}
