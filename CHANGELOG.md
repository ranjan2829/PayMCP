# Changelog

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
