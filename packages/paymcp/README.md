# openapi-to-paymcp

[![npm](https://img.shields.io/npm/v/openapi-to-paymcp.svg)](https://www.npmjs.com/package/openapi-to-paymcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/node/v/openapi-to-paymcp.svg)](https://www.npmjs.com/package/openapi-to-paymcp)

Compile an **OpenAPI 3.x** spec into a **paid MCP server** with HTTP **402** + [x402](https://x402.org) facilitator settlement (`/verify` + `/settle`), then call your upstream API.

Not a new payment protocol — an adapter over existing 402 / x402 semantics. Real facilitator only (no FakeSettler).

> The unscoped name `paymcp` is taken on npm. This package is **`openapi-to-paymcp`**; the CLI binary remains **`paymcp`**.

## Install

```bash
npm i -g openapi-to-paymcp
paymcp ./openapi.yaml --out ./paid-server

# one-shot:
npx openapi-to-paymcp ./openapi.yaml --out ./paid-server

# library:
npm i openapi-to-paymcp
```

```ts
import { paymcpPaywall, loadConfigFromEnv, FacilitatorSettler } from "openapi-to-paymcp";
```

## Required env

```bash
export PAYMCP_FACILITATOR_URL=https://x402.org/facilitator
export PAYMCP_PAY_TO=0xYourRecipientAddress
export PAYMCP_NETWORK=eip155:84532
export PAYMCP_ASSET=0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

Boot fails closed if these are missing or invalid. Full configuration, Sepolia → mainnet live settle, Docker, and security notes: [monorepo README](https://github.com/ranjan2829/PayMCP#readme).

## Security highlights

- Fail-closed verify + settle (no simulated success path)
- **Settle on 2xx only** — settlement runs after a successful upstream/handler response, not on tool-call entry
- `PAYMENT-SIGNATURE` redacted from logs
- **Idempotency-Key** — settled keys replay without re-settle; in-flight keys fail closed (`409`); UNIQUE constraint → one settle wins
- Optional paid-route rate limit
- **Dispute packs** — `paymcp dispute-pack` / `exportDisputePack` (HMAC-signed; no PAYMENT-SIGNATURE payloads)

Report issues privately — see [SECURITY.md](https://github.com/ranjan2829/PayMCP/blob/main/SECURITY.md).

## License

MIT · [ranjan2829/PayMCP](https://github.com/ranjan2829/PayMCP)
