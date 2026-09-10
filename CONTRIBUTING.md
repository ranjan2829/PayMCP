# Contributing

Thanks for interest in PayMCP / `openapi-to-paymcp`.

## Setup

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

Node **20+** and pnpm **9** are required.

## Guidelines

- Prefer small, focused PRs with tests for behavioral changes
- Do not add a FakeSettler or simulated settlement product mode
- Never commit secrets (`.env`, keys, tokens, JWTs)
- Keep logs free of full `PAYMENT-SIGNATURE` / auth material
- Match existing TypeScript style; keep the public API stable unless the PR intentionally revises it

## Protocol fixture vs live money

- `pnpm demo` / unit + integration tests use **recorded facilitator fixtures** — not live funds
- Live settle requires real env + `PAYMCP_LIVE=1` — do not run against mainnet in CI

## License

By contributing, you agree that your contributions are licensed under the MIT License.
