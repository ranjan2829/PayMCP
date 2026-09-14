import type { VisaPaymentPayload } from "../../src/settler/visa.js";
import type { SettlementResponse } from "../../src/types/x402.js";
import { encodeHeaderPayload } from "../../src/headers/codec.js";

export const FIXTURE_VISA_PAYMENT: VisaPaymentPayload = {
  version: 1,
  amount: "10000",
  currency: "USD",
  merchantReference: "paymcp-op-echo",
  credentialRef: "vic_cred_fixture_ref_only",
  network: "visa:vic",
  payer: "agent:fixture",
};

export const FIXTURE_VISA_SETTLE_OK: SettlementResponse & { rail: "visa" } = {
  success: true,
  transaction: "visa_tx_fixture_001",
  network: "visa:vic",
  payer: "agent:fixture",
  rail: "visa",
};

export const FIXTURE_VISA_SETTLE_FAIL: SettlementResponse & { rail: "visa" } = {
  success: false,
  transaction: "",
  network: "visa:vic",
  payer: "agent:fixture",
  errorReason: "credential_declined",
  rail: "visa",
};

export const FIXTURE_VISA_PAYMENT_HEADER = encodeHeaderPayload(FIXTURE_VISA_PAYMENT);

/**
 * Test-only fetch double that speaks verify/settle JSON shapes for VisaVicSettler.
 * Not a product fake mode — inject via fetchImpl in unit tests.
 */
export function createVisaFixtureFetch(behavior: {
  readonly verifyValid?: boolean;
  readonly settle?: SettlementResponse & { rail?: "visa" };
  readonly failTransport?: boolean;
  readonly requireXPay?: boolean;
}): typeof fetch {
  const verifyValid = behavior.verifyValid ?? true;
  const settle = behavior.settle ?? FIXTURE_VISA_SETTLE_OK;

  const impl: typeof fetch = async (input, init) => {
    if (behavior.failTransport) {
      throw new TypeError("network down");
    }
    const url = typeof input === "string" ? input : input.toString();
    if (init?.method !== "POST") {
      return new Response(JSON.stringify({ error: "method" }), { status: 405 });
    }
    if (behavior.requireXPay !== false) {
      const headers = init?.headers;
      const get = (name: string): string | undefined => {
        if (headers === undefined) return undefined;
        if (headers instanceof Headers) return headers.get(name) ?? undefined;
        if (Array.isArray(headers)) {
          const hit = headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
          return hit?.[1];
        }
        const rec = headers as Record<string, string>;
        const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
        return key !== undefined ? rec[key] : undefined;
      };
      const token = get("x-pay-token");
      if (token === undefined || !token.startsWith("xv2:")) {
        return new Response(JSON.stringify({ error: "missing_x_pay_token" }), {
          status: 401,
        });
      }
    }
    if (url.includes("/verify")) {
      return new Response(
        JSON.stringify({
          isValid: verifyValid,
          ...(verifyValid
            ? { payer: FIXTURE_VISA_SETTLE_OK.payer }
            : { invalidReason: "invalid_credential", payer: "" }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/settle")) {
      return new Response(JSON.stringify(settle), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  };
  return impl;
}
