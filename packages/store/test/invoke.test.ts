import { describe, expect, it, vi } from "vitest";
import { openStoreDb } from "../src/db.js";
import { ListingRegistry } from "../src/listings/registry.js";
import { BuyerBalanceLedger } from "../src/ledger/balance.js";
import { InvokeGateway } from "../src/gateway/invoke.js";
import { StoreError } from "../src/errors/index.js";
import { createStoreApp } from "../src/gateway/app.js";
import { loadStoreEnv } from "../src/config/env.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedCatalog } from "../src/seed/catalog.js";
import { SellerKit } from "../src/seller/kit.js";
import { readFileSync } from "node:fs";
import YAML from "js-yaml";
import { fixturesDir } from "../src/seed/catalog.js";

function setup() {
  const db = openStoreDb(":memory:");
  const listings = new ListingRegistry(db);
  const ledger = new BuyerBalanceLedger(db);
  const listing = listings.create({
    id: "lst_echo",
    name: "Echo",
    openapi: {
      openapi: "3.0.3",
      info: { title: "Echo", version: "1" },
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
    payTo: "0x0000000000000000000000000000000000000001",
    network: "eip155:84532",
    upstreamBaseUrl: "http://upstream.test",
    defaultPath: "/echo",
    defaultMethod: "POST",
  });
  return { db, listings, ledger, listing };
}

describe("InvokeGateway", () => {
  it("debits only after upstream 2xx", async () => {
    const { db, listings, ledger, listing } = setup();
    ledger.topUp({ buyerId: "buyer", amount: "50000" });
    const fetchImpl = vi.fn(async () => {
      expect(ledger.getBalance("buyer").balance).toBe("40000"); // held
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const gateway = new InvokeGateway({ listings, ledger, fetchImpl });
    const result = await gateway.invoke({
      listingId: listing.id,
      buyerId: "buyer",
      idempotencyKey: "k1",
      body: { message: "hi" },
    });
    expect(result.ok).toBe(true);
    expect(result.replayed).toBe(false);
    expect(result.balanceAfter).toBe("40000");
    expect(result.spend.status).toBe("settled");
    expect(fetchImpl).toHaveBeenCalledOnce();
    db.close();
  });

  it("refunds on upstream non-2xx", async () => {
    const { db, listings, ledger, listing } = setup();
    ledger.topUp({ buyerId: "buyer", amount: "50000" });
    const gateway = new InvokeGateway({
      listings,
      ledger,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "nope" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(
      gateway.invoke({
        listingId: listing.id,
        buyerId: "buyer",
        idempotencyKey: "k-fail",
        body: {},
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_FAILED", statusCode: 502 });
    expect(ledger.getBalance("buyer").balance).toBe("50000");
    const spend = ledger.findSpendByIdem("k-fail");
    expect(spend?.status).toBe("failed");
    db.close();
  });

  it("replays settled idempotency without re-calling upstream", async () => {
    const { db, listings, ledger, listing } = setup();
    ledger.topUp({ buyerId: "buyer", amount: "50000" });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const gateway = new InvokeGateway({ listings, ledger, fetchImpl });
    await gateway.invoke({
      listingId: listing.id,
      buyerId: "buyer",
      idempotencyKey: "k-replay",
      body: {},
    });
    const second = await gateway.invoke({
      listingId: listing.id,
      buyerId: "buyer",
      idempotencyKey: "k-replay",
      body: {},
    });
    expect(second.replayed).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(ledger.getBalance("buyer").balance).toBe("40000");
    db.close();
  });

  it("fail-closes in-flight idempotency", async () => {
    const { db, listings, ledger, listing } = setup();
    ledger.topUp({ buyerId: "buyer", amount: "50000" });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const gateway = new InvokeGateway({ listings, ledger, fetchImpl });
    const first = gateway.invoke({
      listingId: listing.id,
      buyerId: "buyer",
      idempotencyKey: "k-race",
      body: {},
    });
    // Wait until hold is taken
    await vi.waitFor(() => {
      expect(ledger.findSpendByIdem("k-race")?.status).toBe("pending");
    });
    await expect(
      gateway.invoke({
        listingId: listing.id,
        buyerId: "buyer",
        idempotencyKey: "k-race",
        body: {},
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_IN_FLIGHT", statusCode: 409 });
    release();
    await first;
    db.close();
  });
});

describe("HTTP routes + idempotency", () => {
  it("top-up, catalog, invoke via Fastify inject", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paymcp-store-http-"));
    const dbPath = join(dir, "store.db");
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ echoed: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const env = loadStoreEnv({
      STORE_DB_PATH: dbPath,
      STORE_HOST: "127.0.0.1",
      STORE_PORT: "8799",
      STORE_SEED_PAY_TO: "0x0000000000000000000000000000000000000001",
      STORE_SEED_NETWORK: "eip155:84532",
    });
    const store = await createStoreApp({ env, dbPath, fetchImpl });
    store.listings.create({
      id: "lst_http",
      name: "HTTP Echo",
      openapi: {
        openapi: "3.0.3",
        info: { title: "t", version: "1" },
        paths: {},
      },
      price: "10000",
      sellerId: "s",
      payTo: "0x0000000000000000000000000000000000000001",
      network: "eip155:84532",
      upstreamBaseUrl: "http://upstream.test",
      defaultPath: "/echo",
      defaultMethod: "POST",
      status: "active",
    });

    const top = await store.app.inject({
      method: "POST",
      url: "/v1/top-up",
      payload: { buyerId: "buyer_http", amount: "100000" },
    });
    expect(top.statusCode).toBe(201);

    const catalog = await store.app.inject({ method: "GET", url: "/v1/catalog" });
    expect(catalog.statusCode).toBe(200);
    const catalogBody = catalog.json() as { total: number };
    expect(catalogBody.total).toBeGreaterThanOrEqual(1);

    const inv = await store.app.inject({
      method: "POST",
      url: "/v1/listings/lst_http/invoke",
      headers: { "idempotency-key": "http-idem-1" },
      payload: { buyerId: "buyer_http", body: { message: "x" } },
    });
    expect(inv.statusCode).toBe(200);
    const invBody = inv.json() as {
      ok: boolean;
      balanceAfter: string;
      spend: { status: string };
    };
    expect(invBody.ok).toBe(true);
    expect(invBody.spend.status).toBe("settled");
    expect(invBody.balanceAfter).toBe("90000");

    const replay = await store.app.inject({
      method: "POST",
      url: "/v1/listings/lst_http/invoke",
      headers: { "idempotency-key": "http-idem-1" },
      payload: { buyerId: "buyer_http", body: { message: "x" } },
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { replayed: boolean }).replayed).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();

    const missingKey = await store.app.inject({
      method: "POST",
      url: "/v1/listings/lst_http/invoke",
      payload: { buyerId: "buyer_http" },
    });
    expect(missingKey.statusCode).toBe(400);

    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("SellerKit + seed", () => {
  it("compiles OpenAPI fixture into a listing", () => {
    const db = openStoreDb(":memory:");
    const listings = new ListingRegistry(db);
    const kit = new SellerKit(listings);
    const raw = YAML.load(
      readFileSync(join(fixturesDir(), "echo.openapi.yaml"), "utf8"),
    );
    const { listing, compiled } = kit.register({
      openapi: raw,
      name: "Echo Tool",
      sellerId: "seller_demo",
      payTo: "0x0000000000000000000000000000000000000001",
      network: "eip155:84532",
      upstreamBaseUrl: "http://127.0.0.1:8787",
    });
    expect(listing.price).toBe("10000");
    expect(compiled.primary.operationId).toBe("echoMessage");
    expect(listing.defaultPath).toBe("/echo");
    db.close();
  });

  it("seeds three demo listings including grawwww", () => {
    const db = openStoreDb(":memory:");
    const listings = new ListingRegistry(db);
    const result = seedCatalog({
      listings,
      network: "eip155:84532",
      payTo: "0x0000000000000000000000000000000000000001",
    });
    expect(result.created).toHaveLength(3);
    const graw = listings.getOrThrow("lst_grawwww_render");
    expect(graw.price).toBe("100000"); // 0.10 USDC
    expect(graw.externalX402).toBe(true);
    expect(graw.upstreamBaseUrl).toBe("https://grawwww.xyz");
    // idempotent seed
    const again = seedCatalog({
      listings,
      network: "eip155:84532",
      payTo: "0x0000000000000000000000000000000000000001",
    });
    expect(again.skipped).toHaveLength(3);
    db.close();
  });
});
