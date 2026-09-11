# @paymcp/harness-ci

Agent-trace **quality gate** for PayMCP. Evaluates JSON traces of paid tool/HTTP flows and exits non-zero on policy violations aligned with production:

- settle **only** after 2xx
- `Idempotency-Key` required (no double-charge)
- per-tool budget hard-stops
- no secrets in traces (`PAYMENT-SIGNATURE`, Bearer, PEM, …)

## Run

From the monorepo root:

```bash
pnpm harness:ci
pnpm --filter @paymcp/harness-ci test
pnpm --filter @paymcp/harness-ci typecheck
```

## Fixtures

| Dir | Expectation |
|-----|-------------|
| `fixtures/good/` | Must pass (no violations) |
| `fixtures/bad/` | Must fail (at least one violation) |

## Library

```ts
import { evaluateAgentTrace, parseTraceJson } from "@paymcp/harness-ci";
```
