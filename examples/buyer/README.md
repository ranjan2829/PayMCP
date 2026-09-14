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

**Terminal 1** — PayMCP demo API with a **real** facilitator (Base Sepolia first).
Set these in the environment (names in root `.env.example`; no placeholder values):

- `PAYMCP_FACILITATOR_URL`
- `PAYMCP_PAY_TO`
- `PAYMCP_NETWORK`
- `PAYMCP_ASSET`
- `PAYMCP_ASSET_NAME` (e.g. `USDC` so ExactEvmScheme can sign)

```bash
pnpm --filter @paymcp/demo-api build
pnpm --filter @paymcp/demo-api start
```

**Terminal 2** — inspect the 402 (no wallet, no funds):

```bash
pnpm buyer:probe
```

**Terminal 2** — pay `/echo` (spends testnet USDC; gated). Requires `PAYMCP_LIVE=1`
and `EVM_PRIVATE_KEY` set in the environment (never commit the key):

```bash
export PAYMCP_LIVE=1
# export EVM_PRIVATE_KEY=...   # from your secrets manager / local .env
export DEMO_API_URL=http://127.0.0.1:8787
pnpm buyer:example
```

Copy **variable names** from the repo [`.env.example`](../../.env.example). Never commit `.env`.

## Packages

| Package | Role |
|---------|------|
| `@x402/fetch` `^2.25.0` | wrap `fetch`: 402 → pay → retry |
| `@x402/evm` `^2.25.0` | `ExactEvmScheme` (EIP-3009) |
| `viem` | `privateKeyToAccount` |

See also `scripts/live-settle.mjs` if you already have a base64 `PAYMENT-SIGNATURE`.
