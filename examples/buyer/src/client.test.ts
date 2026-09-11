import { describe, it, expect } from "vitest";
import {
  createPaidFetch,
  decodeJsonHeader,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  summarizePaymentRequiredHeader,
  summarizeSettlementHeader,
  summarizeSignatureHeader,
} from "./client.js";

/** Well-known Anvil/Hardhat account #0 — local signing only, not a funded wallet. */
const ANVIL_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const REQUIRED = {
  x402Version: 2,
  error: "PAYMENT-SIGNATURE header is required",
  resource: {
    url: "http://127.0.0.1:8787/echo",
    description: "Echo one JSON payload",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    },
  ],
};

const SETTLED = {
  success: true,
  transaction:
    "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  network: "eip155:84532",
  payer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
};

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

describe("header helpers (no chain)", () => {
  it("summarizes PAYMENT-REQUIRED the way PayMCP encodes it", () => {
    const header = b64(REQUIRED);
    const summary = summarizePaymentRequiredHeader(header);
    expect(summary?.x402Version).toBe(2);
    expect(summary?.amount).toBe("10000");
    expect(summary?.network).toBe("eip155:84532");
    expect(summary?.payTo).toBe(REQUIRED.accepts[0]?.payTo);
    expect(decodeJsonHeader(header)).toEqual(REQUIRED);
  });

  it("redacts settlement tx in the summary", () => {
    const summary = summarizeSettlementHeader(b64(SETTLED));
    expect(summary.present).toBe(true);
    expect(summary.success).toBe(true);
    expect(summary.transactionPrefix?.startsWith("0x1234567890abcdef")).toBe(
      true,
    );
    expect(summary.transactionPrefix?.includes("1234567890abcdef1234567890abcdef1234")).toBe(
      false,
    );
  });

  it("reports missing signature headers", () => {
    expect(summarizeSignatureHeader(null)).toEqual({
      present: false,
      length: 0,
    });
  });
});

describe("@x402/fetch wrap against a PayMCP-shaped 402 (offline)", () => {
  it("retries with PAYMENT-SIGNATURE after 402 + PAYMENT-REQUIRED", async () => {
    const captured: { signatures: string[] } = { signatures: [] };

    const mockFetch: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const sig =
        req.headers.get(HEADER_PAYMENT_SIGNATURE) ??
        req.headers.get("payment-signature");
      if (sig === null || sig.length === 0) {
        return new Response(JSON.stringify({ error: "payment_required" }), {
          status: 402,
          headers: {
            "content-type": "application/json",
            [HEADER_PAYMENT_REQUIRED]: b64(REQUIRED),
          },
        });
      }
      captured.signatures.push(sig);
      const payload = decodeJsonHeader(sig) as {
        x402Version: number;
        accepted: { amount: string; network: string; payTo: string };
        payload: { signature?: string; authorization?: { to?: string } };
      };
      expect(payload.x402Version).toBe(2);
      expect(payload.accepted.amount).toBe("10000");
      expect(payload.accepted.network).toBe("eip155:84532");
      expect(payload.accepted.payTo).toBe(REQUIRED.accepts[0]?.payTo);
      expect(typeof payload.payload.signature).toBe("string");
      return new Response(JSON.stringify({ echo: "hello from @x402/fetch" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          [HEADER_PAYMENT_RESPONSE]: b64(SETTLED),
        },
      });
    };

    const fetchWithPayment = createPaidFetch({
      privateKey: ANVIL_KEY,
      networkPattern: "eip155:*",
      fetchImpl: mockFetch,
      maxAmountPerPayment: "$1",
    });

    const res = await fetchWithPayment("http://127.0.0.1:8787/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello from @x402/fetch" }),
    });

    expect(res.status).toBe(200);
    expect(captured.signatures).toHaveLength(1);
    const body = (await res.json()) as { echo: string };
    expect(body.echo).toBe("hello from @x402/fetch");
    const settlement = summarizeSettlementHeader(
      res.headers.get(HEADER_PAYMENT_RESPONSE),
    );
    expect(settlement.success).toBe(true);
  });
});
