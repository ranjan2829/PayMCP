import { createHmac } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import {
  SettlementWebhookSender,
  createSettlementWebhookSender,
  WEBHOOK_SIGNATURE_HEADER,
  SETTLEMENT_WEBHOOK_EVENT,
  SETTLEMENT_WEBHOOK_VERSION,
} from "../../src/webhook/settlement.js";
import { loadConfigFromEnv } from "../../src/types/config.js";

const SECRET = "test-webhook-secret-32chars!!";
const URL = "https://billing.example/webhooks/paymcp";

function makeSender(fetchImpl: typeof fetch, maxRetries = 0) {
  return new SettlementWebhookSender({
    url: URL,
    secret: SECRET,
    fetchImpl,
    maxRetries,
    timeoutMs: 1_000,
  });
}

const notifyInput = {
  operationId: "echoMessage",
  amount: "10000",
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  transaction:
    "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  idempotencyKey: "idem-1",
  settledAt: "2026-09-12T00:00:00.000Z",
  requestId: "req-abc",
};

describe("SettlementWebhookSender", () => {
  it("POSTs signed JSON without PAYMENT-SIGNATURE material", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response("{}", { status: 200 });
    };
    const sender = makeSender(fetchImpl);
    await sender.notify(notifyInput);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    const body = String(calls[0]!.init.body);
    expect(body).not.toMatch(/PAYMENT-SIGNATURE/i);
    expect(body).not.toMatch(/0x2d6a7588/);
    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(payload).toMatchObject({
      event: SETTLEMENT_WEBHOOK_EVENT,
      version: SETTLEMENT_WEBHOOK_VERSION,
      operationId: "echoMessage",
      amount: "10000",
      network: "eip155:84532",
      asset: notifyInput.asset,
      payer: notifyInput.payer,
      transaction: notifyInput.transaction,
      idempotencyKey: "idem-1",
      settledAt: "2026-09-12T00:00:00.000Z",
      requestId: "req-abc",
    });
    const expectedSig =
      "sha256=" +
      createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
    expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBe(expectedSig);
  });

  it("retries 5xx then succeeds", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n += 1;
      if (n < 3) {
        return new Response("err", { status: 503 });
      }
      return new Response("{}", { status: 200 });
    };
    const sender = makeSender(fetchImpl, 3);
    await sender.notify(notifyInput);
    expect(n).toBe(3);
  });

  it("does not throw on permanent failure (settle path safe)", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("no", { status: 400 });
    const sender = makeSender(fetchImpl, 0);
    await expect(sender.notify(notifyInput)).resolves.toBeUndefined();
  });

  it("signBody is deterministic HMAC", () => {
    const sender = makeSender(async () => new Response("{}", { status: 200 }));
    const body = '{"a":1}';
    expect(sender.signBody(body)).toBe(sender.signBody(body));
    expect(sender.signBody(body)).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe("createSettlementWebhookSender", () => {
  const baseEnv = {
    PAYMCP_FACILITATOR_URL: "https://x402.org/facilitator",
    PAYMCP_PAY_TO: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    PAYMCP_NETWORK: "eip155:84532",
    PAYMCP_ASSET: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  };

  it("returns undefined when webhook URL unset", () => {
    const cfg = loadConfigFromEnv(baseEnv);
    expect(createSettlementWebhookSender(cfg)).toBeUndefined();
  });

  it("builds sender when URL + secret set", () => {
    const cfg = loadConfigFromEnv({
      ...baseEnv,
      PAYMCP_WEBHOOK_URL: URL,
      PAYMCP_WEBHOOK_SECRET: SECRET,
    });
    const sender = createSettlementWebhookSender(cfg);
    expect(sender).toBeInstanceOf(SettlementWebhookSender);
  });
});

describe("loadConfigFromEnv webhook", () => {
  const base = {
    PAYMCP_FACILITATOR_URL: "https://x402.org/facilitator",
    PAYMCP_PAY_TO: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    PAYMCP_NETWORK: "eip155:84532",
    PAYMCP_ASSET: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  };

  it("loads webhook env", () => {
    const cfg = loadConfigFromEnv({
      ...base,
      PAYMCP_WEBHOOK_URL: "https://billing.example/hook",
      PAYMCP_WEBHOOK_SECRET: SECRET,
      PAYMCP_WEBHOOK_TIMEOUT_MS: "8000",
      PAYMCP_WEBHOOK_MAX_RETRIES: "1",
    });
    expect(cfg.webhookUrl).toBe("https://billing.example/hook");
    expect(cfg.webhookSecret).toBe(SECRET);
    expect(cfg.webhookTimeoutMs).toBe(8000);
    expect(cfg.webhookMaxRetries).toBe(1);
  });

  it("requires secret when URL set", () => {
    expect(() =>
      loadConfigFromEnv({
        ...base,
        PAYMCP_WEBHOOK_URL: "https://billing.example/hook",
      }),
    ).toThrow(/PAYMCP_WEBHOOK_SECRET/);
  });
});
