import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStoreDb } from "../src/db.js";
import { ListingRegistry } from "../src/listings/registry.js";
import { BuyerBalanceLedger } from "../src/ledger/balance.js";
import {
  RecordingPayoutExecutor,
  SellerPayoutQueue,
  SellerPayoutService,
} from "../src/payout/index.js";
import { InvokeGateway } from "../src/gateway/invoke.js";
import { createStoreApp } from "../src/gateway/app.js";
import { loadStoreEnv } from "../src/config/env.js";
import { ReceiptService } from "../src/receipts/service.js";
import { renderReceiptHtml } from "../src/receipts/html.js";
import { redactBuyerId } from "../src/receipts/redact.js";
import { explorerTxUrl } from "../src/receipts/explorer.js";
import {
  requireLiveListingEnv,
  seedLiveListing,
  LIVE_PUBLIC_LISTING_ID,
} from "../src/seed/live-listing.js";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const TX =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("redactBuyerId", () => {
  it("masks middle of buyer id", () => {
    expect(redactBuyerId("buyer_demo_agent")).toMatch(/^buye…gent$/);
  });
});

describe("explorerTxUrl", () => {
  it("links Base Sepolia", () => {
    expect(explorerTxUrl("eip155:84532", TX)).toBe(
      `https://sepolia.basescan.org/tx/${TX}`,
    );
  });
  it("links Base mainnet", () => {
    expect(explorerTxUrl("eip155:8453", TX)).toBe(
      `https://basescan.org/tx/${TX}`,
    );
  });
  it("skips non-hex fixture txs", () => {
    expect(explorerTxUrl("eip155:84532", "0xrecording")).toBeNull();
  });
});

describe("requireLiveListingEnv", () => {
  it("fails closed when env missing", () => {
    expect(() => requireLiveListingEnv({})).toThrow(/STORE_SEED_PAY_TO/);
  });
  it("accepts real env shape", () => {
    const live = requireLiveListingEnv({
      STORE_SEED_PAY_TO: PAY_TO,
      PAYMCP_ASSET: ASSET,
      PAYMCP_FACILITATOR_URL: "https://x402.org/facilitator",
      STORE_SEED_NETWORK: "eip155:84532",
    });
    expect(live.payTo).toBe(PAY_TO);
    expect(live.network).toBe("eip155:84532");
  });
});

describe("ReceiptService + routes", () => {
  it("builds public receipt with redacted buyer and explorer link", async () => {
    const db = openStoreDb(":memory:");
    const listings = new ListingRegistry(db);
    const ledger = new BuyerBalanceLedger(db);
    const payoutQueue = new SellerPayoutQueue(db);
    const payouts = new SellerPayoutService({
      queue: payoutQueue,
      executor: new RecordingPayoutExecutor({
        transaction: TX,
        network: "eip155:84532",
        payer: "test",
      }),
      defaultAsset: ASSET,
    });
    const listing = listings.create({
      id: "lst_r",
      name: "Receipt Tool",
      openapi: {
        openapi: "3.0.3",
        info: { title: "R", version: "1" },
        paths: {
          "/echo": {
            post: {
              operationId: "echoMessage",
              "x-paymcp": { amount: "10000" },
            },
          },
        },
      },
      price: "10000",
      sellerId: "seller",
      payTo: PAY_TO,
      network: "eip155:84532",
      upstreamBaseUrl: "http://upstream.test",
      defaultPath: "/echo",
      defaultMethod: "POST",
    });
    ledger.creditFromFunding({
      buyerId: "buyer_agent_one",
      amount: "50000",
      fundingId: "fund_rcpt_1",
      source: "test_fixture",
    });
    const gateway = new InvokeGateway({
      listings,
      ledger,
      payouts,
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const result = await gateway.invoke({
      listingId: listing.id,
      buyerId: "buyer_agent_one",
      idempotencyKey: randomUUID(),
      body: { message: "hi" },
    });
    expect(result.spend.status).toBe("settled");
    expect(result.payout?.transaction).toBe(TX);

    const receipts = new ReceiptService({
      listings,
      ledger,
      payouts: payoutQueue,
      publicBaseUrl: "http://127.0.0.1:8790",
    });
    const receipt = receipts.getByIdOrTx(result.spend.id);
    expect(receipt.buyer).not.toContain("buyer_agent_one");
    expect(receipt.buyer).toMatch(/…/);
    expect(receipt.amount).toBe("10000");
    expect(receipt.settleStatus).toBe("settled");
    expect(receipt.payoutStatus).toBe("paid");
    expect(receipt.explorerUrl).toContain("sepolia.basescan.org");
    expect(receipt.receiptUrl).toBe(
      `http://127.0.0.1:8790/v1/receipts/${result.spend.id}`,
    );

    const byTx = receipts.getByIdOrTx(TX);
    expect(byTx.spendId).toBe(result.spend.id);

    const html = renderReceiptHtml(receipt);
    expect(html).toContain("PayMCP");
    expect(html).toContain("#b8ff3c");
    expect(html).not.toContain("buyer_agent_one");

    const list = receipts.listRecent({ limit: 10 });
    expect(list.total).toBeGreaterThanOrEqual(1);
    expect(list.receipts[0]?.spendId).toBe(result.spend.id);

    db.close();
  });

  it("exposes GET /v1/receipts via Fastify", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paymcp-rcpt-"));
    const dbPath = join(dir, "store.db");
    try {
      const env = loadStoreEnv({
        STORE_DB_PATH: dbPath,
        STORE_REQUIRE_PAYOUT: "0",
        STORE_PUBLIC_BASE_URL: "http://127.0.0.1:8790",
        STORE_SEED_PAY_TO: PAY_TO,
        PAYMCP_ASSET: ASSET,
        LOG_LEVEL: "error",
      } as NodeJS.ProcessEnv);

      const store = await createStoreApp({
        env,
        dbPath,
        payoutExecutor: new RecordingPayoutExecutor({
          transaction: TX,
          network: "eip155:84532",
          payer: "test",
        }),
        requirePayout: true,
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      });

      store.listings.create({
        id: "lst_http_rcpt",
        name: "HTTP Receipt",
        openapi: {
          openapi: "3.0.3",
          info: { title: "H", version: "1" },
          paths: {
            "/echo": {
              post: {
                operationId: "echoMessage",
                "x-paymcp": { amount: "25000" },
              },
            },
          },
        },
        price: "25000",
        sellerId: "seller",
        payTo: PAY_TO,
        network: "eip155:84532",
        upstreamBaseUrl: "http://upstream.test",
        defaultPath: "/echo",
        defaultMethod: "POST",
      });
      store.ledger.creditFromFunding({
        buyerId: "buyer_http",
        amount: "100000",
        fundingId: "fund_http_1",
        source: "test_fixture",
      });

      await store.app.ready();

      const invokeRes = await store.app.inject({
        method: "POST",
        url: "/v1/listings/lst_http_rcpt/invoke",
        headers: {
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        payload: { buyerId: "buyer_http", body: { message: "x" } },
      });
      expect(invokeRes.statusCode).toBe(200);
      const invokeBody = invokeRes.json() as {
        spend: { id: string };
        receiptUrl?: string;
      };
      expect(invokeBody.receiptUrl).toContain("/v1/receipts/");

      const spendId = invokeBody.spend.id;
      const jsonRes = await store.app.inject({
        method: "GET",
        url: `/v1/receipts/${spendId}`,
      });
      expect(jsonRes.statusCode).toBe(200);
      const { receipt } = jsonRes.json() as {
        receipt: { spendId: string; buyer: string; amount: string };
      };
      expect(receipt.spendId).toBe(spendId);
      expect(receipt.buyer).not.toBe("buyer_http");
      expect(receipt.amount).toBe("25000");

      const htmlRes = await store.app.inject({
        method: "GET",
        url: `/v1/receipts/${spendId}?format=html`,
      });
      expect(htmlRes.statusCode).toBe(200);
      expect(htmlRes.headers["content-type"]).toMatch(/text\/html/);
      expect(htmlRes.body).toContain("HTTP Receipt");

      const listRes = await store.app.inject({
        method: "GET",
        url: "/v1/receipts?limit=5",
      });
      expect(listRes.statusCode).toBe(200);
      const list = listRes.json() as { total: number; receipts: unknown[] };
      expect(list.total).toBeGreaterThanOrEqual(1);

      const missing = await store.app.inject({
        method: "GET",
        url: "/v1/receipts/does-not-exist",
      });
      expect(missing.statusCode).toBe(404);

      await store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("seedLiveListing", () => {
  it("seeds lst_live_echo with env payTo", () => {
    const db = openStoreDb(":memory:");
    const listings = new ListingRegistry(db);
    const live = requireLiveListingEnv({
      STORE_SEED_PAY_TO: PAY_TO,
      PAYMCP_ASSET: ASSET,
      PAYMCP_FACILITATOR_URL: "https://x402.org/facilitator",
    });
    const result = seedLiveListing(listings, live);
    expect(result.created).toBe(true);
    expect(result.listing.id).toBe(LIVE_PUBLIC_LISTING_ID);
    expect(result.listing.payTo).toBe(PAY_TO);
    const again = seedLiveListing(listings, live);
    expect(again.created).toBe(false);
    db.close();
  });
});
