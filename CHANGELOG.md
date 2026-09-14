# Changelog

## Unreleased

- PayMCP: Visa Trusted Agent Protocol (TAP) verifier + Visa VIC settler dual rail (`rail: x402|visa|auto`); receipts include settled rail; docs in `packages/paymcp/docs/VISA_TAP_VIC.md`.
- Store: public receipt surface (`GET /v1/receipts`, HTML page), `seed-live` Base demo listing (fail-closed env), buyer demo curl docs for X screenshots.
- Store: remove faucet top-up; Stripe Checkout + webhook funding; seller USDC payout on invoke settle; require `STORE_SEED_PAY_TO`; scrub placeholder secrets from docs/env examples.


## 0.2.0

- Settle only after successful 2xx responses
- Idempotent retries via `Idempotency-Key` (no double charge)
- Allowlist + per-tool daily budgets
- Signed dispute / evidence packs (`paymcp dispute-pack`)
- Buyer example path with `@x402/fetch`
- Harness-ci agent-trace quality gate
- HMAC-signed settlement webhooks to billing
- Docker/compose fixes for monorepo workspaces

## 0.1.0

- Initial public release: OpenAPI → paid MCP + Fastify 402 with real x402 facilitator settlement
