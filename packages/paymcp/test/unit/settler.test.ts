import { describe, it, expect } from "vitest";
import {
  FacilitatorSettler,
  FacilitatorHttpError,
  FacilitatorTransportError,
} from "../../src/settler/facilitator.js";
import {
  createFacilitatorFixtureFetch,
  FIXTURE_ACCEPT,
  FIXTURE_PAYLOAD,
  FIXTURE_SETTLE_FAIL,
} from "../fixtures/facilitator.js";

describe("FacilitatorSettler", () => {
  it("verifyAndSettle succeeds against fixture facilitator protocol", async () => {
    const settler = new FacilitatorSettler({
      baseUrl: "https://facilitator.example/x402",
      fetchImpl: createFacilitatorFixtureFetch({ verifyValid: true }),
    });
    const result = await settler.verifyAndSettle({
      paymentPayload: FIXTURE_PAYLOAD,
      paymentRequirements: FIXTURE_ACCEPT,
    });
    expect(result.success).toBe(true);
    expect(result.transaction.length).toBeGreaterThan(10);
  });

  it("returns failure when verify rejects", async () => {
    const settler = new FacilitatorSettler({
      baseUrl: "https://facilitator.example/x402",
      fetchImpl: createFacilitatorFixtureFetch({ verifyValid: false }),
    });
    const result = await settler.verifyAndSettle({
      paymentPayload: FIXTURE_PAYLOAD,
      paymentRequirements: FIXTURE_ACCEPT,
    });
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("invalid_signature");
  });

  it("propagates settle failure reason", async () => {
    const settler = new FacilitatorSettler({
      baseUrl: "https://facilitator.example/x402",
      fetchImpl: createFacilitatorFixtureFetch({
        verifyValid: true,
        settle: FIXTURE_SETTLE_FAIL,
      }),
    });
    const result = await settler.verifyAndSettle({
      paymentPayload: FIXTURE_PAYLOAD,
      paymentRequirements: FIXTURE_ACCEPT,
    });
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("insufficient_funds");
  });

  it("retries on 5xx then succeeds", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      calls += 1;
      const url = String(input);
      if (url.endsWith("/verify")) {
        if (calls === 1) {
          return new Response(JSON.stringify({ error: "upstream" }), {
            status: 503,
          });
        }
        return new Response(
          JSON.stringify({
            isValid: true,
            payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/settle")) {
        return new Response(
          JSON.stringify({
            success: true,
            transaction: "0xabc",
            network: FIXTURE_ACCEPT.network,
            payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    };
    const settler = new FacilitatorSettler({
      baseUrl: "https://facilitator.example/x402",
      fetchImpl,
      maxRetries: 2,
      timeoutMs: 5_000,
    });
    const result = await settler.verifyAndSettle({
      paymentPayload: FIXTURE_PAYLOAD,
      paymentRequirements: FIXTURE_ACCEPT,
    });
    expect(result.success).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("does not retry on 4xx", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "bad_request" }), {
        status: 400,
      });
    };
    const settler = new FacilitatorSettler({
      baseUrl: "https://facilitator.example/x402",
      fetchImpl,
      maxRetries: 3,
    });
    await expect(
      settler.verify({
        paymentPayload: FIXTURE_PAYLOAD,
        paymentRequirements: FIXTURE_ACCEPT,
      }),
    ).rejects.toBeInstanceOf(FacilitatorHttpError);
    expect(calls).toBe(1);
  });

  it("surfaces transport errors", async () => {
    const settler = new FacilitatorSettler({
      baseUrl: "https://facilitator.example/x402",
      fetchImpl: createFacilitatorFixtureFetch({ failTransport: true }),
      maxRetries: 0,
    });
    await expect(
      settler.verify({
        paymentPayload: FIXTURE_PAYLOAD,
        paymentRequirements: FIXTURE_ACCEPT,
      }),
    ).rejects.toBeInstanceOf(FacilitatorTransportError);
  });
});
