import { randomUUID } from "node:crypto";
import {
  isStripeFundingEnabled,
  isUsdcPayoutConfigured,
  loadStoreEnv,
  requireSeedPayTo,
} from "../config/env.js";
import { createStoreApp } from "../gateway/app.js";
import { seedCatalog } from "../seed/catalog.js";
import {
  requireLiveListingEnv,
  seedLiveListing,
  LIVE_PUBLIC_LISTING_ID,
} from "../seed/live-listing.js";
import { ReceiptService } from "../receipts/service.js";
import { SellerPayoutQueue } from "../payout/queue.js";
import { openStoreDb } from "../db.js";
import { ListingRegistry } from "../listings/registry.js";
import { BuyerBalanceLedger } from "../ledger/balance.js";
import { RecordingPayoutExecutor } from "../payout/index.js";
import { StripeFundingClient, creditsForUsdCents } from "../funding/stripe.js";

function printHelp(): void {
  console.log(`paymcp-store — PayMCP Store CLI

Usage:
  paymcp-store serve              Start Fastify store server
  paymcp-store seed               Seed demo catalog (requires STORE_SEED_PAY_TO)
  paymcp-store seed-live          Seed ONE live Base listing (fail-closed env)
  paymcp-store fund-checkout <buyer> <fiatCents>   Stripe Checkout URL (requires Stripe env)
  paymcp-store catalog            List active catalog
  paymcp-store balance <buyer>    Print buyer balance
  paymcp-store invoke <listingId> <buyerId> [--body JSON] [--path PATH]
  paymcp-store spend-log [buyer]  Print spend log
  paymcp-store receipt <spendId|tx>   Print public receipt JSON (+ URL)
  paymcp-store receipts [limit]   List recent public settlements
  paymcp-store payouts-flush      Retry pending seller payouts
  paymcp-store buyer-flow <buyer> Catalog → invoke → spend-log (requires funded balance)

Env (names only — set real values in the environment, never commit secrets):
  STORE_HOST STORE_PORT STORE_DB_PATH STORE_SEED_NETWORK STORE_SEED_PAY_TO
  STORE_PUBLIC_BASE_URL PAYMCP_FACILITATOR_URL PAYMCP_ASSET PAYMCP_ASSET_NAME
  STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_SUCCESS_URL STRIPE_CANCEL_URL
  STORE_OPERATOR_PRIVATE_KEY STORE_RPC_URL
`);
}

export async function runStoreCli(argv: string[]): Promise<void> {
  const cmd = argv[0] ?? "help";
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  const env = loadStoreEnv();

  if (cmd === "serve") {
    const store = await createStoreApp({ env });
    const { total } = store.listings.list({ limit: 1, offset: 0 });
    if (total === 0) {
      const payTo = requireSeedPayTo(env);
      const seeded = seedCatalog({
        listings: store.listings,
        network: env.STORE_SEED_NETWORK,
        payTo,
      });
      store.app.log.info(
        { created: seeded.created },
        "seeded empty catalog",
      );
    }
    const address = await store.app.listen({
      host: env.STORE_HOST,
      port: env.STORE_PORT,
    });
    console.log(`PayMCP Store listening at ${address}`);
    if (!isStripeFundingEnabled(env)) {
      console.log(
        "Stripe funding disabled — set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET to enable POST /v1/funding/checkout",
      );
    }
    if (!isUsdcPayoutConfigured(env)) {
      console.log(
        "Warning: USDC payout env incomplete — seller payouts on invoke require STORE_OPERATOR_PRIVATE_KEY, STORE_RPC_URL, PAYMCP_ASSET",
      );
    }
    return;
  }

  let db: ReturnType<typeof openStoreDb> | undefined = openStoreDb(env.STORE_DB_PATH);
  const listings = new ListingRegistry(db);
  const ledger = new BuyerBalanceLedger(db);

  try {
    if (cmd === "seed") {
      const payTo = requireSeedPayTo(env);
      const result = seedCatalog({
        listings,
        network: env.STORE_SEED_NETWORK,
        payTo,
        force: argv.includes("--force"),
      });
      console.log(
        JSON.stringify(
          {
            created: result.created,
            skipped: result.skipped,
            listings: result.listings.map((l) => ({
              id: l.id,
              name: l.name,
              price: l.price,
              payTo: l.payTo,
              externalX402: l.externalX402,
              upstreamBaseUrl: l.upstreamBaseUrl,
            })),
          },
          null,
          2,
        ),
      );
      return;
    }

    if (cmd === "seed-live") {
      const liveEnv: {
        STORE_SEED_PAY_TO?: string;
        STORE_SEED_NETWORK?: string;
        PAYMCP_ASSET?: string;
        PAYMCP_FACILITATOR_URL?: string;
        STORE_LIVE_UPSTREAM_BASE_URL?: string;
      } = {
        STORE_SEED_NETWORK: env.STORE_SEED_NETWORK,
      };
      if (env.STORE_SEED_PAY_TO !== undefined) {
        liveEnv.STORE_SEED_PAY_TO = env.STORE_SEED_PAY_TO;
      }
      if (env.PAYMCP_ASSET !== undefined) {
        liveEnv.PAYMCP_ASSET = env.PAYMCP_ASSET;
      }
      if (env.PAYMCP_FACILITATOR_URL !== undefined) {
        liveEnv.PAYMCP_FACILITATOR_URL = env.PAYMCP_FACILITATOR_URL;
      }
      const upstream = process.env["STORE_LIVE_UPSTREAM_BASE_URL"];
      if (upstream !== undefined && upstream.length > 0) {
        liveEnv.STORE_LIVE_UPSTREAM_BASE_URL = upstream;
      }
      const live = requireLiveListingEnv(liveEnv);
      const result = seedLiveListing(listings, {
        ...live,
        force: argv.includes("--force"),
      });
      console.log(
        JSON.stringify(
          {
            listingId: result.listing.id,
            created: result.created,
            name: result.listing.name,
            price: result.listing.price,
            payTo: result.listing.payTo,
            network: result.network,
            asset: result.asset,
            facilitatorUrl: result.facilitatorUrl,
            hint: `Invoke ${LIVE_PUBLIC_LISTING_ID} then GET /v1/receipts/:spendId`,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (cmd === "receipt" || cmd === "receipts") {
      const payoutQueue = new SellerPayoutQueue(db);
      const receipts = new ReceiptService({
        listings,
        ledger,
        payouts: payoutQueue,
        ...(env.STORE_PUBLIC_BASE_URL !== undefined
          ? { publicBaseUrl: env.STORE_PUBLIC_BASE_URL }
          : {}),
        assetLabel: env.PAYMCP_ASSET_NAME ?? "USDC",
      });
      if (cmd === "receipts") {
        const limit = argv[1] !== undefined ? Number(argv[1]) : 20;
        console.log(JSON.stringify(receipts.listRecent({ limit }), null, 2));
        return;
      }
      const id = argv[1];
      if (id === undefined) {
        throw new Error("usage: paymcp-store receipt <spendId|txHash>");
      }
      const receipt = receipts.getByIdOrTx(id);
      console.log(JSON.stringify({ receipt }, null, 2));
      return;
    }

    if (cmd === "top-up") {
      throw new Error(
        "Faucet top-up removed. Use: paymcp-store fund-checkout <buyerId> <fiatCents> " +
          "(Stripe) — credits apply after verified webhook.",
      );
    }

    if (cmd === "fund-checkout") {
      const buyerId = argv[1];
      const centsRaw = argv[2];
      if (buyerId === undefined || centsRaw === undefined) {
        throw new Error(
          "usage: paymcp-store fund-checkout <buyerId> <fiatAmountCents>",
        );
      }
      if (!isStripeFundingEnabled(env)) {
        throw new Error(
          "STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required for fund-checkout",
        );
      }
      const fiatAmountCents = Number(centsRaw);
      if (!Number.isInteger(fiatAmountCents) || fiatAmountCents < 50) {
        throw new Error("fiatAmountCents must be an integer >= 50");
      }
      const successUrl =
        env.STRIPE_SUCCESS_URL ??
        (env.STORE_PUBLIC_BASE_URL !== undefined
          ? `${env.STORE_PUBLIC_BASE_URL}/v1/funding/success`
          : undefined);
      const cancelUrl =
        env.STRIPE_CANCEL_URL ??
        (env.STORE_PUBLIC_BASE_URL !== undefined
          ? `${env.STORE_PUBLIC_BASE_URL}/v1/funding/cancel`
          : undefined);
      if (successUrl === undefined || cancelUrl === undefined) {
        throw new Error(
          "Set STRIPE_SUCCESS_URL and STRIPE_CANCEL_URL (or STORE_PUBLIC_BASE_URL)",
        );
      }
      const creditAmount = creditsForUsdCents(fiatAmountCents);
      const client = new StripeFundingClient({
        secretKey: env.STRIPE_SECRET_KEY!,
        webhookSecret: env.STRIPE_WEBHOOK_SECRET!,
      });
      const session = await client.createCheckoutSession({
        buyerId,
        creditAmount,
        fiatAmountCents,
        successUrl,
        cancelUrl,
      });
      console.log(
        JSON.stringify(
          { sessionId: session.id, url: session.url, creditAmount, buyerId },
          null,
          2,
        ),
      );
      return;
    }

    if (cmd === "catalog") {
      const { listings: rows, total } = listings.list({
        status: "active",
        limit: 50,
        offset: 0,
      });
      console.log(
        JSON.stringify(
          {
            total,
            listings: rows.map((l) => ({
              id: l.id,
              name: l.name,
              price: l.price,
              payTo: l.payTo,
              network: l.network,
              externalX402: l.externalX402,
              defaultPath: l.defaultPath,
              defaultMethod: l.defaultMethod,
            })),
          },
          null,
          2,
        ),
      );
      return;
    }

    if (cmd === "balance") {
      const buyerId = argv[1];
      if (buyerId === undefined) {
        throw new Error("usage: paymcp-store balance <buyerId>");
      }
      console.log(JSON.stringify({ balance: ledger.getBalance(buyerId) }, null, 2));
      return;
    }

    if (cmd === "spend-log") {
      const buyerId = argv[1];
      const result = ledger.listSpendLog(
        buyerId !== undefined ? { buyerId, limit: 50, offset: 0 } : { limit: 50, offset: 0 },
      );
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (cmd === "payouts-flush") {
      const store = await createStoreApp({
        env,
        dbPath: env.STORE_DB_PATH,
        requirePayout: true,
      });
      try {
        const result = await store.payouts.flushPending();
        console.log(JSON.stringify(result, null, 2));
      } finally {
        await store.close();
      }
      return;
    }

    if (cmd === "invoke") {
      const listingId = argv[1];
      const buyerId = argv[2];
      if (listingId === undefined || buyerId === undefined) {
        throw new Error(
          "usage: paymcp-store invoke <listingId> <buyerId> [--body JSON]",
        );
      }
      let body: unknown = { message: "hello from paymcp-store cli" };
      const bodyIdx = argv.indexOf("--body");
      if (bodyIdx >= 0 && argv[bodyIdx + 1] !== undefined) {
        body = JSON.parse(argv[bodyIdx + 1]!);
      }
      let path: string | undefined;
      const pathIdx = argv.indexOf("--path");
      if (pathIdx >= 0 && argv[pathIdx + 1] !== undefined) {
        path = argv[pathIdx + 1];
      }

      const base =
        env.STORE_PUBLIC_BASE_URL ??
        `http://${env.STORE_HOST}:${env.STORE_PORT}`;
      const idem = randomUUID();
      const res = await fetch(`${base}/v1/listings/${listingId}/invoke`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idem,
        },
        body: JSON.stringify({
          buyerId,
          ...(path !== undefined ? { path } : {}),
          body,
        }),
      });
      const json: unknown = await res.json();
      console.log(JSON.stringify({ status: res.status, body: json }, null, 2));
      if (!res.ok) {
        process.exitCode = 1;
      }
      return;
    }

    if (cmd === "buyer-flow") {
      const buyerId = argv[1] ?? "buyer_demo";
      console.log("== 1) balance (must be funded via Stripe checkout + webhook) ==");
      const balance = ledger.getBalance(buyerId);
      console.log(JSON.stringify(balance, null, 2));
      if (BigInt(balance.balance) <= 0n) {
        throw new Error(
          `buyer ${buyerId} has zero balance. Fund via: paymcp-store fund-checkout ${buyerId} <fiatCents> ` +
            "then complete Stripe Checkout (webhook credits the ledger). No faucet.",
        );
      }

      console.log("\n== 2) catalog ==");
      let { listings: rows } = listings.list({
        status: "active",
        limit: 50,
        offset: 0,
      });
      if (rows.length === 0) {
        const payTo = requireSeedPayTo(env);
        seedCatalog({
          listings,
          network: env.STORE_SEED_NETWORK,
          payTo,
        });
        rows = listings.list({ status: "active", limit: 50, offset: 0 }).listings;
      }
      console.log(
        JSON.stringify(
          rows.map((l) => ({
            id: l.id,
            name: l.name,
            price: l.price,
            payTo: l.payTo,
            externalX402: l.externalX402,
          })),
          null,
          2,
        ),
      );

      const target =
        rows.find((l) => l.id === "lst_echo_demo" && !l.externalX402) ??
        rows.find((l) => !l.externalX402);
      if (target === undefined) {
        console.log(
          "\nNo non-external listing to invoke in-process. Seeded catalog listed above.",
        );
        console.log("\n== spend-log ==");
        console.log(
          JSON.stringify(ledger.listSpendLog({ buyerId, limit: 20, offset: 0 }), null, 2),
        );
        return;
      }

      db.close();
      db = undefined;

      const mockFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.includes("/echo") || url.includes("127.0.0.1:8787")) {
          return new Response(
            JSON.stringify({
              ok: true,
              echo: init?.body !== undefined ? JSON.parse(String(init.body)) : null,
              via: "buyer-flow-mock-upstream",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: "not mocked" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      };

      // Local buyer-flow uses recording payout (not live chain) unless operator env set.
      const payoutExecutor = isUsdcPayoutConfigured(env)
        ? undefined
        : new RecordingPayoutExecutor({
            transaction: "0xbuyer_flow_local_payout",
            network: env.STORE_SEED_NETWORK,
            payer: "local-buyer-flow",
          });
      const store = await createStoreApp({
        env,
        dbPath: env.STORE_DB_PATH,
        fetchImpl: mockFetch,
        ...(payoutExecutor !== undefined ? { payoutExecutor } : {}),
        requirePayout: true,
      });

      try {
        console.log(`\n== 3) invoke ${target.id} ==`);
        const result = await store.invoke.invoke({
          listingId: target.id,
          buyerId,
          idempotencyKey: randomUUID(),
          body: { message: "buyer-flow hello" },
        });
        const base =
          env.STORE_PUBLIC_BASE_URL ??
          `http://${env.STORE_HOST}:${env.STORE_PORT}`;
        const receiptUrl = `${base.replace(/\/$/, "")}/v1/receipts/${result.spend.id}`;
        console.log(
          JSON.stringify(
            {
              replayed: result.replayed,
              upstreamStatus: result.upstreamStatus,
              balanceAfter: result.balanceAfter,
              spend: result.spend,
              payout: result.payout,
              receiptUrl,
              body: result.body,
            },
            null,
            2,
          ),
        );
        console.log(`\nReceipt (HTML): ${receiptUrl}?format=html`);

        console.log("\n== 4) spend-log ==");
        console.log(
          JSON.stringify(
            store.ledger.listSpendLog({ buyerId, limit: 20, offset: 0 }),
            null,
            2,
          ),
        );
      } finally {
        await store.close();
      }
      return;
    }

    printHelp();
    throw new Error(`unknown command: ${cmd}`);
  } finally {
    db?.close();
  }
}
