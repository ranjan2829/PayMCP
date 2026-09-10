# paymcp — coding agent skill

Compile an OpenAPI 3.x spec into a **paid MCP server** whose tools settle via a real x402 HTTP facilitator (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`), then call the upstream API.

## When to use

- You have an existing OpenAPI file and want MCP tools gated by micropayments.
- You need Fastify middleware that protects selected routes the same way.

## Prerequisites

Node 20+, pnpm 9+. Real facilitator credentials/URL (no simulated settlement mode).

Required env:

```bash
export PAYMCP_FACILITATOR_URL=https://x402.org/facilitator   # or CDP: https://api.cdp.coinbase.com/platform/v2/x402
export PAYMCP_PAY_TO=0xYourRecipient
export PAYMCP_NETWORK=eip155:84532                          # CAIP-2
export PAYMCP_ASSET=0x036CbD53842c5426634e7929541eC2318f3dCF7e
# Optional for CDP auth:
# export PAYMCP_FACILITATOR_AUTH_TOKEN="Bearer <jwt>"
```

## Compile

```bash
pnpm exec paymcp ./openapi.yaml --out ./paid-server
# or boot immediately:
pnpm exec paymcp ./openapi.yaml --serve --upstream http://127.0.0.1:8787
```

Prices come from OpenAPI `x-paymcp.amount` or `--prices prices.yaml`.

## Library

```ts
import {
  paymcpPaywall,
  loadConfigFromEnv,
  FacilitatorSettler,
  buildPriceTable,
  loadOpenApi,
  compileOperations,
} from "openapi-to-paymcp";
```

## Do not

- Do not invent a parallel payment protocol — adapt 402 / x402 headers only.
- Do not add a fake/mock settler for demos; use fixture HTTP only inside tests.
