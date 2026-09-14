# Live Base receipt demo (X screenshot kit)

One public paid tool behind PayMCP Store → unpaid **402** / spend-log / **settle receipt** URL.

Default network in docs: **Base Sepolia** (`eip155:84532`). Base mainnet via env only.

## Required env (names only — fail closed)

| Variable | Purpose |
|----------|---------|
| `STORE_SEED_PAY_TO` | Real seller recipient (0x…) |
| `PAYMCP_ASSET` | USDC contract on the chosen network |
| `PAYMCP_FACILITATOR_URL` | Facilitator base URL |
| `STORE_SEED_NETWORK` | Default `eip155:84532`; mainnet `eip155:8453` |
| `STORE_OPERATOR_PRIVATE_KEY` | Treasury key for seller USDC payout |
| `STORE_RPC_URL` | JSON-RPC for the same network |
| `STORE_PUBLIC_BASE_URL` | Public origin for absolute receipt URLs (e.g. `http://127.0.0.1:8790`) |

Optional: `STORE_LIVE_UPSTREAM_BASE_URL` (defaults to local demo-api `http://127.0.0.1:8787`), Stripe vars for fiat → credits.

**No faucet. No placeholder keys in examples.** Copy root `.env.example` and set real values.

## 1) Seed the live listing

```bash
# from monorepo root — env must already export the vars above
pnpm --filter @paymcp/store cli seed-live
# → listingId: lst_live_echo
```

## 2) Start store (+ demo upstream for echo)

```bash
# terminal A — demo API (echo upstream)
pnpm demo   # or your upstream at STORE_LIVE_UPSTREAM_BASE_URL

# terminal B
pnpm --filter @paymcp/store dev
# → http://127.0.0.1:8790
```

## 3) Buyer path A — Stripe credits → invoke → receipt

```bash
# Checkout (requires STRIPE_* + success/cancel URLs)
pnpm --filter @paymcp/store cli fund-checkout buyer_x 100
# Complete Stripe in browser; webhook credits ledger

# Unpaid / empty balance → 402
curl -s -o /tmp/unpaid.json -w '%{http_code}\n' \
  -X POST http://127.0.0.1:8790/v1/listings/lst_live_echo/invoke \
  -H 'content-type: application/json' \
  -H "idempotency-key: $(uuidgen)" \
  -d '{"buyerId":"buyer_x","body":{"message":"no funds"}}'
# expect 402 + INSUFFICIENT_BALANCE

# After funding — settle
IDEM=$(uuidgen)
curl -s -X POST http://127.0.0.1:8790/v1/listings/lst_live_echo/invoke \
  -H 'content-type: application/json' \
  -H "idempotency-key: $IDEM" \
  -d '{"buyerId":"buyer_x","body":{"message":"paid hello"}}' | tee /tmp/invoke.json

# Receipt URL is in the JSON (receiptUrl) — or:
SPEND=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/invoke.json","utf8")).spend.id)')
open "http://127.0.0.1:8790/v1/receipts/$SPEND?format=html"
# JSON: curl -s "http://127.0.0.1:8790/v1/receipts/$SPEND"
```

## 4) Buyer path B — x402 on-chain (external / paymcp path)

Use `examples/buyer` with `PAYMCP_LIVE=1` and `EVM_PRIVATE_KEY` in the environment (never commit). After settle, store credit-path receipts still come from Store invoke; for pure x402 MCP settle, use PayMCP dispute/spend tooling. For the **Store receipt URL** screenshot, prefer path A (or funded invoke above).

## 5) Public receipt surface

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/v1/receipts/:spendId` | JSON receipt (amount, listing, redacted buyer, settle/payout, explorer link) |
| `GET` | `/v1/receipts/:spendId?format=html` | Dark receipt page (void black + lime) |
| `GET` | `/v1/receipts/:txHash` | Same, resolved via payout tx |
| `GET` | `/v1/receipts?limit=20` | Recent **settled** public receipts |

Spend log (operator): `GET /v1/spend-log?buyerId=buyer_x`

## What’s left for real Base mainnet

Set env only (no code changes):

- `STORE_SEED_NETWORK=eip155:8453`
- `PAYMCP_ASSET` = Base mainnet USDC
- `PAYMCP_FACILITATOR_URL` + auth (`PAYMCP_FACILITATOR_AUTH_TOKEN` / CDP keys as required)
- `STORE_RPC_URL` = Base mainnet RPC
- `STORE_OPERATOR_PRIVATE_KEY` funded with gas + USDC for seller payouts
- `STORE_SEED_PAY_TO` = real seller address
- Re-run `seed-live --force` and serve with `STORE_PUBLIC_BASE_URL` pointing at your public host
