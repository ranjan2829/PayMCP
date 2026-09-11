# Buyer example (`@x402/fetch`)

**Example only** — this is not a new payment protocol. It is the official
[x402 buyer client](https://docs.x402.org/getting-started/quickstart-for-buyers)
wired to a PayMCP 402 paywall.

```
unpaid request
    → HTTP 402 + PAYMENT-REQUIRED
    → @x402/fetch + ExactEvmScheme signs PAYMENT-SIGNATURE
    → retry
    → PayMCP verifies (facilitator /verify), handler 2xx, settle (/settle)
    → HTTP 200 + PAYMENT-RESPONSE
```

The buyer **does not** call the facilitator. The PayMCP server does.

## Run against local demo-api

**Terminal 1** — PayMCP demo API with a **real** facilitator (Base Sepolia first):

```bash
export PAYMCP_FACILITATOR_URL=https://x402.org/facilitator
export PAYMCP_PAY_TO=0xYourRecipient
export PAYMCP_NETWORK=eip155:84532
export PAYMCP_ASSET=0x036CbD53842c5426634e7929541eC2318f3dCF7e
export PAYMCP_ASSET_NAME=USDC   # EIP-712 name so ExactEvmScheme can sign
pnpm --filter @paymcp/demo-api build
pnpm --filter @paymcp/demo-api start
```

**Terminal 2** — inspect the 402 (no wallet, no funds):

```bash
pnpm buyer:probe
# or: pnpm --filter @paymcp/buyer-example probe
```

**Terminal 2** — pay `/echo` (spends testnet USDC; gated):

```bash
export PAYMCP_LIVE=1
export EVM_PRIVATE_KEY=0xYourPayerKey
export DEMO_API_URL=http://127.0.0.1:8787
# optional: PAYMCP_BUYER_PATH=/weather   PAYMCP_BUYER_METHOD=GET
pnpm buyer:example
```

Copy env names from the repo [`.env.example`](../../.env.example). Never commit `.env`.

## Packages

| Package | Role |
|---------|------|
| `@x402/fetch` `^2.25.0` | wrap `fetch`: 402 → pay → retry |
| `@x402/evm` `^2.25.0` | `ExactEvmScheme` (EIP-3009) |
| `viem` | `privateKeyToAccount` |

See also `scripts/live-settle.mjs` if you already have a base64 `PAYMENT-SIGNATURE`.
