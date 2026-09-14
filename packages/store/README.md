# @paymcp/store

Paid-agent-tools **mini marketplace** on top of [`openapi-to-paymcp`](../paymcp).

Agents discover tool listings, fund a **credit balance** via **Stripe Checkout**
(verified webhook), and invoke paid tools without holding an `EVM_PRIVATE_KEY`
on the buyer happy path. Debits mirror PayMCP **settle-on-2xx**: balance is held
before upstream, finalized only after success, refunded on upstream failure, and
**seller payout** runs to the listing `payTo` (USDC transfer from store treasury).
Optional settlement webhooks reuse the PayMCP `settlement.succeeded` shape.

There is **no faucet**, no free mint route, and no zero-address `payTo` default.

## Features

| Area | What |
|------|------|
| **Listings registry** | CRUD: id, name, description, OpenAPI URL/inline, price (atomic USDC/credits), sellerId, payTo, network, status |
| **Seller kit** | OpenAPI + prices → compile ops (`compileOperations` / `buildPriceTable`) → register listing |
| **Buyer ledger** | Verified funding credit (Stripe webhook), beginSpend hold, completeSpend settle/refund, spend log |
| **Funding** | `POST /v1/funding/checkout` + `POST /v1/webhooks/stripe` (HMAC verified) |
| **Seller payout** | On invoke 2xx → enqueue + execute USDC transfer to listing `payTo` |
| **Gateway** | Fastify routes for catalog, listings, funding, balance, spend-log, invoke, payouts flush |
| **Seed** | Echo, weather, and **grawwww** `render/image` (0.10 USDC) external x402 live target |
| **Public receipts** | `GET /v1/receipts/:spendId` + recent list — amount, listing, redacted buyer, settle/payout, explorer link |
| **Live listing** | `seed-live` — one production listing; fail closed without real `STORE_SEED_PAY_TO` / asset / facilitator |

## Quickstart

```bash
# from monorepo root
pnpm install
pnpm --filter @paymcp/store typecheck
pnpm --filter @paymcp/store test

# set STORE_SEED_PAY_TO (and payout/Stripe keys for live) in the environment — see root .env.example
pnpm --filter @paymcp/store seed
pnpm --filter @paymcp/store dev
# → http://127.0.0.1:8790
```

## HTTP API

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/healthz` | Liveness |
| `GET` | `/readyz` | DB ready |
| `GET` | `/v1/catalog` | Active listings |
| `GET` | `/v1/catalog/:id` | Listing detail |
| `POST` | `/v1/listings` | Create listing (seller) |
| `PATCH` | `/v1/listings/:id` | Update listing |
| `DELETE` | `/v1/listings/:id` | Delete listing |
| `POST` | `/v1/funding/checkout` | Stripe Checkout session (`buyerId`, `fiatAmountCents`) — requires Stripe env |
| `POST` | `/v1/webhooks/stripe` | Verified Stripe webhook → credit ledger (idempotent) |
| `POST` | `/v1/top-up` | **410 Gone** — faucet removed |
| `GET` | `/v1/balances/:buyerId` | Credit balance |
| `GET` | `/v1/spend-log` | Query spend log |
| `POST` | `/v1/payouts/flush` | Retry pending/failed seller payouts |
| `GET` | `/v1/receipts` | Recent public settlements (limit) |
| `GET` | `/v1/receipts/:id` | Public receipt by spend id or payout tx (`?format=html` for dark page) |
| `POST` | `/v1/listings/:id/invoke` | **Requires `Idempotency-Key`**; debit + seller payout after upstream 2xx; returns `receiptUrl` |

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
  name: "My Tool",
  sellerId: "seller_1",
  payTo: process.env.STORE_SEED_PAY_TO!, // real recipient from env
  network: "eip155:84532",
  upstreamBaseUrl: "https://api.example.com",
});
```

## Buyer funding + invoke

```bash
# 1) Create Stripe Checkout (requires STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET + success/cancel URLs)
pnpm --filter @paymcp/store cli fund-checkout buyer_demo 100

# 2) Complete payment in the browser; Stripe webhook credits the ledger

# 3) Invoke (store must be running; seller payout needs STORE_OPERATOR_PRIVATE_KEY + STORE_RPC_URL + PAYMCP_ASSET)
curl -s -X POST http://127.0.0.1:8790/v1/listings/lst_echo_demo/invoke \
  -H 'content-type: application/json' \
  -H 'idempotency-key: '"$(uuidgen)" \
  -d '{"buyerId":"buyer_demo","body":{"message":"hi"}}'

curl -s 'http://127.0.0.1:8790/v1/spend-log?buyerId=buyer_demo'
```

**No `EVM_PRIVATE_KEY` on the buyer** for the store credit path. The **store operator**
key pays sellers on settle.

## Live x402 test (grawwww)

Seeded listing `lst_grawwww_render`:

- Upstream: `https://grawwww.xyz`
- Path: `/api/render/image`
- Price: `100000` atomic (= **0.10 USDC** at 6 decimals)
- `externalX402: true`

Buyers can still pay on-chain with `@x402/fetch` (see `examples/buyer`) using
`EVM_PRIVATE_KEY` from the environment — never commit that value.

## CLI

```
paymcp-store serve
paymcp-store seed [--force]
paymcp-store seed-live [--force]   # ONE live Base listing (fail-closed env)
paymcp-store fund-checkout <buyerId> <fiatAmountCents>
paymcp-store catalog
paymcp-store balance <buyerId>
paymcp-store invoke <listingId> <buyerId> [--body JSON] [--path PATH]
paymcp-store spend-log [buyerId]
paymcp-store receipt <spendId|tx>
paymcp-store receipts [limit]
paymcp-store payouts-flush
paymcp-store buyer-flow [buyerId]   # requires already-funded balance (no faucet)
```

## Live Base receipt demo

See [docs/LIVE_BASE_DEMO.md](./docs/LIVE_BASE_DEMO.md) for the exact curl flow (402 → fund → invoke → receipt URL) for an X screenshot.


## Env

Set variable **names** in the environment (see root [`.env.example`](../../.env.example)).
No placeholder secret values in docs.

| Variable | Required when | Purpose |
|----------|---------------|---------|
| `STORE_HOST` / `STORE_PORT` | optional | Bind (defaults `127.0.0.1:8790`) |
| `STORE_DB_PATH` | optional | SQLite path |
| `STORE_PUBLIC_BASE_URL` | CLI HTTP / Stripe URL defaults | Public base URL |
| `STORE_SEED_NETWORK` | optional | Seed network (default `eip155:84532`) |
| `STORE_SEED_PAY_TO` | **seed / serve auto-seed** | Seed listing payTo — **no default** |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | funding routes | Stripe Checkout + webhook verify |
| `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL` | funding | Checkout redirect URLs |
| `STORE_OPERATOR_PRIVATE_KEY` | seller payout | Treasury key for USDC transfer |
| `STORE_RPC_URL` | seller payout | EVM JSON-RPC URL |
| `PAYMCP_ASSET` | seller payout | USDC contract address |
| `PAYMCP_WEBHOOK_URL` / `PAYMCP_WEBHOOK_SECRET` | optional | Settlement webhook |

## Design notes

- **No faucet** — credits only after verified Stripe payment (or USDC deposit path).
- **No FakeSettler** — seller payout is a real USDC transfer (or facilitator settle adapter).
- **Idempotency** — `Idempotency-Key` on invoke; funding idempotent on Stripe session id.
- **Settle-on-2xx** — hold → upstream → debit + payout; non-2xx refunds the hold.
