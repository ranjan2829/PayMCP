# @paymcp/store

Paid-agent-tools **mini marketplace** on top of [`openapi-to-paymcp`](../paymcp).

Agents discover tool listings, top up a **credit balance**, and invoke paid tools
without holding an `EVM_PRIVATE_KEY` on the happy path. Debits mirror PayMCP
**settle-on-2xx**: balance is held before upstream, finalized only after success,
and refunded on upstream failure. Optional settlement webhooks reuse the existing
PayMCP `settlement.succeeded` shape.

## Features

| Area | What |
|------|------|
| **Listings registry** | CRUD: id, name, description, OpenAPI URL/inline, price (atomic USDC/credits), sellerId, payTo, network, status |
| **Seller kit** | OpenAPI + prices → compile ops (`compileOperations` / `buildPriceTable`) → register listing |
| **Buyer ledger** | Top-up (dev faucet), beginSpend hold, completeSpend settle/refund, spend log |
| **Gateway** | Fastify routes for catalog, listings, top-up, balance, spend-log, invoke |
| **Seed** | Echo, weather, and **grawwww** `render/image` (0.10 USDC) external x402 live target |

## Quickstart

```bash
# from monorepo root
pnpm install
pnpm --filter @paymcp/store typecheck
pnpm --filter @paymcp/store test

# seed + serve
pnpm --filter @paymcp/store seed
pnpm --filter @paymcp/store dev
# → http://127.0.0.1:8790
```

Copy store keys from the root [`.env.example`](../../.env.example) (`STORE_*`).

## HTTP API

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/healthz` | Liveness |
| `GET` | `/readyz` | DB ready |
| `GET` | `/v1/catalog` | Active listings (query: status, sellerId, tag, limit, offset) |
| `GET` | `/v1/catalog/:id` | Listing detail |
| `POST` | `/v1/listings` | Create listing (seller) |
| `PATCH` | `/v1/listings/:id` | Update listing |
| `DELETE` | `/v1/listings/:id` | Delete listing |
| `POST` | `/v1/top-up` | `{ buyerId, amount, note? }` — MVP faucet |
| `GET` | `/v1/balances/:buyerId` | Credit balance |
| `GET` | `/v1/spend-log` | Query spend log |
| `POST` | `/v1/listings/:id/invoke` | **Requires `Idempotency-Key`**; debit after upstream 2xx |

### Invoke body

```json
{
  "buyerId": "buyer_demo",
  "path": "/echo",
  "method": "POST",
  "body": { "message": "hello" },
  "query": {},
  "headers": {}
}
```

## Seller flow

```ts
import { openStoreDb, ListingRegistry, SellerKit } from "@paymcp/store";

const db = openStoreDb("./paymcp-store.db");
const listings = new ListingRegistry(db);
const kit = new SellerKit(listings);

const { listing } = kit.register({
  openapiPath: "./my-tool.openapi.yaml",
  // or pricesPath: "./prices.yaml",
  name: "My Tool",
  sellerId: "seller_1",
  payTo: "0xYourRecipientAddress",
  network: "eip155:84532",
  upstreamBaseUrl: "https://api.example.com",
});
```

Seller kit uses PayMCP compiler + price table patterns. For full HTTP 402 paywalls
on your own Fastify API, keep using `paymcpPaywall` from `openapi-to-paymcp`.

## Buyer balance flow

```bash
# CLI (in-process top-up / catalog / mock invoke / spend-log)
pnpm --filter @paymcp/store cli buyer-flow buyer_demo 1000000

# Or HTTP against a running store:
curl -s -X POST http://127.0.0.1:8790/v1/top-up \
  -H 'content-type: application/json' \
  -d '{"buyerId":"buyer_demo","amount":"1000000"}'

curl -s http://127.0.0.1:8790/v1/catalog | jq .

curl -s -X POST http://127.0.0.1:8790/v1/listings/lst_echo_demo/invoke \
  -H 'content-type: application/json' \
  -H 'idempotency-key: '"$(uuidgen)" \
  -d '{"buyerId":"buyer_demo","body":{"message":"hi"}}'

curl -s 'http://127.0.0.1:8790/v1/spend-log?buyerId=buyer_demo' | jq .
```

**No `EVM_PRIVATE_KEY` required** for the store credit path.

## Live x402 test (grawwww)

Seeded listing `lst_grawwww_render`:

- Upstream: `https://grawwww.xyz`
- Path: `/api/render/image`
- Price: `100000` atomic (= **0.10 USDC** at 6 decimals)
- `externalX402: true`

### Option A — on-chain with `@x402/fetch` (real USDC)

Wire a buyer against the live endpoint (same pattern as `examples/buyer`):

```bash
# Probe 402 challenge (no funds):
curl -i -X POST https://grawwww.xyz/api/render/image

# Pay with @x402/fetch (spends USDC — requires EVM_PRIVATE_KEY):
# See examples/buyer README. Point DEMO_API_URL / path at grawwww.
PAYMCP_LIVE=1 \
EVM_PRIVATE_KEY=0x... \
DEMO_API_URL=https://grawwww.xyz \
PAYMCP_BUYER_PATH=/api/render/image \
PAYMCP_BUYER_METHOD=POST \
pnpm buyer:example
```

The **facilitator** runs on the seller/x402 server side. The buyer only signs
and retries with `PAYMENT-SIGNATURE`.

### Option B — store balance path

For local demos, keep `lst_echo_demo` / `lst_weather_demo` pointed at
`examples/demo-api` (`http://127.0.0.1:8787`). Invoke through the store so
credits debit after 2xx — no chain key on the agent.

## CLI

```
paymcp-store serve
paymcp-store seed [--force]
paymcp-store top-up <buyerId> <atomicAmount>
paymcp-store catalog
paymcp-store balance <buyerId>
paymcp-store invoke <listingId> <buyerId> [--body JSON] [--path PATH]
paymcp-store spend-log [buyerId]
paymcp-store buyer-flow [buyerId] [topUpAtomic]
```

## Env

| Variable | Default | Purpose |
|----------|---------|---------|
| `STORE_HOST` | `127.0.0.1` | Bind host |
| `STORE_PORT` | `8790` | Bind port |
| `STORE_DB_PATH` | `./paymcp-store.db` | SQLite path (listings + buyer ledger) |
| `STORE_PUBLIC_BASE_URL` | — | Base URL for CLI HTTP invoke |
| `STORE_SEED_NETWORK` | `eip155:84532` | Seed listing network |
| `STORE_SEED_PAY_TO` | `0x…0001` | Seed listing payTo |
| `PAYMCP_WEBHOOK_URL` | — | Optional settlement webhook |
| `PAYMCP_WEBHOOK_SECRET` | — | HMAC secret (≥16 chars) when webhook set |

## Design notes

- **No FakeSettler** — on-chain paths use real facilitators via PayMCP; credit
  path is an explicit balance ledger, not mock settlement.
- **Idempotency** — `Idempotency-Key` on invoke; settled keys replay; pending
  keys fail closed (`409`).
- **Module boundaries** — listings, ledger, gateway, seller, seed are separate;
  typed `StoreError` at API boundaries.
