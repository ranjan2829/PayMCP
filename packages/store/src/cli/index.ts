import { randomUUID } from "node:crypto";
import { loadStoreEnv } from "../config/env.js";
import { createStoreApp } from "../gateway/app.js";
import { seedCatalog } from "../seed/catalog.js";
import { openStoreDb } from "../db.js";
import { ListingRegistry } from "../listings/registry.js";
import { BuyerBalanceLedger } from "../ledger/balance.js";

function printHelp(): void {
  console.log(`paymcp-store — PayMCP Store CLI

Usage:
  paymcp-store serve              Start Fastify store server
  paymcp-store seed               Seed demo catalog (echo, weather, grawwww)
  paymcp-store top-up <buyer> <atomicAmount>
  paymcp-store catalog            List active catalog
  paymcp-store balance <buyer>    Print buyer balance
  paymcp-store invoke <listingId> <buyerId> [--body JSON] [--path PATH]
  paymcp-store spend-log [buyer]  Print spend log
  paymcp-store buyer-flow <buyer> Run top-up → catalog → invoke → spend-log

Env: STORE_HOST STORE_PORT STORE_DB_PATH STORE_SEED_NETWORK STORE_SEED_PAY_TO
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
    // Auto-seed empty DB
    const { total } = store.listings.list({ limit: 1, offset: 0 });
    if (total === 0) {
      const seeded = seedCatalog({
        listings: store.listings,
        network: env.STORE_SEED_NETWORK,
        payTo: env.STORE_SEED_PAY_TO,
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
    return;
  }

  const db = openStoreDb(env.STORE_DB_PATH);
  const listings = new ListingRegistry(db);
  const ledger = new BuyerBalanceLedger(db);

  try {
    if (cmd === "seed") {
      const result = seedCatalog({
        listings,
        network: env.STORE_SEED_NETWORK,
        payTo: env.STORE_SEED_PAY_TO,
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

    if (cmd === "top-up") {
      const buyerId = argv[1];
      const amount = argv[2];
      if (buyerId === undefined || amount === undefined) {
        throw new Error("usage: paymcp-store top-up <buyerId> <atomicAmount>");
      }
      const balance = ledger.topUp({ buyerId, amount, note: "cli top-up" });
      console.log(JSON.stringify({ balance }, null, 2));
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

      // Use HTTP against running server when STORE_PUBLIC_BASE_URL set; else in-process.
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
      const topUpAmount = argv[2] ?? "1000000"; // 1 USDC worth of credits

      console.log("== 1) top-up ==");
      const balance = ledger.topUp({
        buyerId,
        amount: topUpAmount,
        note: "buyer-flow faucet",
      });
      console.log(JSON.stringify(balance, null, 2));

      console.log("\n== 2) catalog ==");
      let { listings: rows } = listings.list({
        status: "active",
        limit: 50,
        offset: 0,
      });
      if (rows.length === 0) {
        seedCatalog({
          listings,
          network: env.STORE_SEED_NETWORK,
          payTo: env.STORE_SEED_PAY_TO,
        });
        rows = listings.list({ status: "active", limit: 50, offset: 0 }).listings;
      }
      console.log(
        JSON.stringify(
          rows.map((l) => ({
            id: l.id,
            name: l.name,
            price: l.price,
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
        console.log(
          "Start the store (`paymcp-store serve`) and a mock upstream, then: paymcp-store invoke …",
        );
        console.log("\n== spend-log ==");
        console.log(
          JSON.stringify(ledger.listSpendLog({ buyerId, limit: 20, offset: 0 }), null, 2),
        );
        return;
      }

      // In-process invoke with mock fetch if upstream is local and unreachable —
      // prefer HTTP when server is up; otherwise use InvokeGateway with mock.
      const { InvokeGateway } = await import("../gateway/invoke.js");
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

      const gateway = new InvokeGateway({
        listings,
        ledger,
        fetchImpl: mockFetch,
      });

      console.log(`\n== 3) invoke ${target.id} ==`);
      const result = await gateway.invoke({
        listingId: target.id,
        buyerId,
        idempotencyKey: randomUUID(),
        body: { message: "buyer-flow hello" },
      });
      console.log(
        JSON.stringify(
          {
            replayed: result.replayed,
            upstreamStatus: result.upstreamStatus,
            balanceAfter: result.balanceAfter,
            spend: result.spend,
            body: result.body,
          },
          null,
          2,
        ),
      );

      console.log("\n== 4) spend-log ==");
      console.log(
        JSON.stringify(ledger.listSpendLog({ buyerId, limit: 20, offset: 0 }), null, 2),
      );
      return;
    }

    printHelp();
    throw new Error(`unknown command: ${cmd}`);
  } finally {
    db.close();
  }
}
