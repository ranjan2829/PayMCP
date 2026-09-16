# Fiat funding (Stripe → credits → invoke)

PayMCP Store does **not** charge a card on every tool call. Humans fund with **fiat via Stripe Checkout**; agents spend **credits**; settle happens **only after upstream 2xx** (same settle-on-success rule as x402).

## Flow

1. `POST /v1/funding/checkout` with `{ buyerId, fiatAmountCents }`  
   → Stripe Checkout Session URL (`creditAmount` defaults to USDC 6-decimal parity: $1 = `1000000` atomic).
2. Buyer pays card on Stripe.
3. Stripe sends `checkout.session.completed` to `POST /v1/webhooks/stripe` with `Stripe-Signature`.
4. Store verifies HMAC, credits `buyerId` idempotently (`fundingId = stripe:{sessionId}`).
5. `POST /v1/listings/:id/invoke` with `Idempotency-Key` debits credits only after upstream 2xx, enqueues seller USDC payout, returns `receiptUrl`.

Legacy `POST /v1/top-up` returns **410** (faucet removed).

## Env

```bash
STRIPE_SECRET_KEY=sk_live_...          # or sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_SUCCESS_URL=https://your.host/v1/funding/success
STRIPE_CANCEL_URL=https://your.host/v1/funding/cancel
STORE_PUBLIC_BASE_URL=https://your.host

# seller payout still required for full settle
STORE_OPERATOR_PRIVATE_KEY=0x...
STORE_RPC_URL=https://...
PAYMCP_ASSET=0x...   # USDC
STORE_SEED_PAY_TO=0x...
```

Point Stripe Dashboard webhook at `/v1/webhooks/stripe` for `checkout.session.completed`.

## Local test without live Stripe

```bash
pnpm --filter @paymcp/store test
# includes fiat-e2e: signed webhook → credit → invoke → receipt
```

## Product rule

Fiat funds the balance. Agents never hold card PANs. Capture/settle semantics stay **success-gated**.
