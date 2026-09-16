import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadStoreEnv } from "../src/config/env.js";
import { createStoreApp, type StoreApp } from "../src/gateway/app.js";
import type { SellerPayoutExecutor } from "../src/payout/index.js";

class RecordingPayoutExecutor implements SellerPayoutExecutor {
  readonly calls: unknown[] = [];
  async execute(input: {
    to: string;
    amount: string;
    asset: string;
    idempotencyKey: string;
  }): Promise<{ txHash: string }> {
    this.calls.push(input);
    return { txHash: `0x${"ab".repeat(32)}` };
  }
}

function signStripeBody(body: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret)
    .update(`${t}.${body}`, "utf8")
    .digest("hex");
  return `t=${t},v1=${v1}`;
}

describe("fiat Stripe → credits → invoke → receipt", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length) {
      await closers.pop()!();
    }
  });

  it("credits from verified webhook then settles invoke with receiptUrl", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "paymcp-fiat-")), "s.db");
    const webhookSecret = "whsec_fiat_e2e_secret_value_ok";
    const env = loadStoreEnv({
      STORE_HOST: "127.0.0.1",
      STORE_PORT: "8790",
      STORE_DB_PATH: dbPath,
      STORE_PUBLIC_BASE_URL: "http://127.0.0.1:8790",
      STORE_SEED_NETWORK: "eip155:84532",
      STORE_REQUIRE_PAYOUT: "1",
      PAYMCP_ASSET: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      STRIPE_SECRET_KEY: "sk_test_fiat_e2e_not_called",
      STRIPE_WEBHOOK_SECRET: webhookSecret,
      STRIPE_SUCCESS_URL: "http://127.0.0.1:8790/v1/funding/success",
      STRIPE_CANCEL_URL: "http://127.0.0.1:8790/v1/funding/cancel",
    });

    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, echo: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const payoutExecutor = new RecordingPayoutExecutor();
    const store: StoreApp = await createStoreApp({
      env,
      dbPath,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      payoutExecutor,
    });
    closers.push(() => store.close());

    store.listings.create({
      id: "lst_fiat",
      name: "Fiat Echo",
      openapi: {
        openapi: "3.0.3",
        info: { title: "t", version: "1" },
        paths: {},
      },
      price: "1000000",
      sellerId: "seller_fiat",
      payTo: "0x2222222222222222222222222222222222222222",
      network: "eip155:84532",
      upstreamBaseUrl: "http://upstream.test",
      defaultPath: "/echo",
      defaultMethod: "POST",
      status: "active",
    });

    // Before funding: invoke should fail (insufficient)
    const broke = await store.app.inject({
      method: "POST",
      url: "/v1/listings/lst_fiat/invoke",
      headers: { "idempotency-key": "fiat-broke-1" },
      payload: { buyerId: "buyer_fiat", body: { hi: 1 } },
    });
    expect(broke.statusCode).toBeGreaterThanOrEqual(400);

    const sessionId = "cs_test_fiat_e2e_1";
    const eventBody = JSON.stringify({
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          payment_status: "paid",
          metadata: {
            purpose: "paymcp_store_credits",
            buyerId: "buyer_fiat",
            creditAmount: "5000000",
          },
        },
      },
    });
    const sig = signStripeBody(eventBody, webhookSecret);

    const wh = await store.app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": sig,
      },
      payload: eventBody,
    });
    expect(wh.statusCode).toBe(200);
    const whBody = wh.json() as {
      received: boolean;
      credited: boolean;
      balance: { balance: string };
    };
    expect(whBody.received).toBe(true);
    expect(whBody.credited).toBe(true);
    expect(whBody.balance.balance).toBe("5000000");

    // Replay webhook — no double credit
    const wh2 = await store.app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": sig,
      },
      payload: eventBody,
    });
    expect(wh2.statusCode).toBe(200);
    expect((wh2.json() as { balance: { balance: string } }).balance.balance).toBe(
      "5000000",
    );

    const bal = await store.app.inject({
      method: "GET",
      url: "/v1/balances/buyer_fiat",
    });
    expect(bal.statusCode).toBe(200);
    expect((bal.json() as { balance: { balance: string } }).balance.balance).toBe(
      "5000000",
    );

    const inv = await store.app.inject({
      method: "POST",
      url: "/v1/listings/lst_fiat/invoke",
      headers: { "idempotency-key": "fiat-inv-1" },
      payload: { buyerId: "buyer_fiat", body: { message: "paid with fiat credits" } },
    });
    expect(inv.statusCode).toBe(200);
    const invBody = inv.json() as {
      ok: boolean;
      balanceAfter: string;
      spend: { id: string; status: string };
      receiptUrl?: string;
      payout: { status: string } | null;
    };
    expect(invBody.ok).toBe(true);
    expect(invBody.spend.status).toBe("settled");
    expect(invBody.balanceAfter).toBe("4000000");
    expect(invBody.receiptUrl).toContain("/v1/receipts/");
    expect(payoutExecutor.calls.length).toBe(1);

    const rcpt = await store.app.inject({
      method: "GET",
      url: `/v1/receipts/${invBody.spend.id}`,
    });
    expect(rcpt.statusCode).toBe(200);
    expect((rcpt.json() as { receipt: { spendId: string } }).receipt.spendId).toBe(
      invBody.spend.id,
    );

    const success = await store.app.inject({
      method: "GET",
      url: "/v1/funding/success",
    });
    expect(success.statusCode).toBe(200);
    expect(success.headers["content-type"]).toContain("text/html");

    const cancel = await store.app.inject({
      method: "GET",
      url: "/v1/funding/cancel",
    });
    expect(cancel.statusCode).toBe(200);
  });
});
