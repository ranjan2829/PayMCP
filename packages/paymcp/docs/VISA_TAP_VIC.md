# Visa TAP + VIC rail on PayMCP

PayMCP keeps a single paid MCP/tool path and can settle on either:

| Rail | What it does |
|------|----------------|
| **x402** | Existing USDC facilitator verify + settle (Base / CDP). |
| **visa** | Visa Intelligent Commerce–style credential settle via X-Pay HTTP. |

**Trusted Agent Protocol (TAP)** sits beside both rails. TAP uses RFC 9421 HTTP Message Signatures (`Signature-Input` / `Signature`) so merchants can authenticate an agent (`agent-browser-auth` or `agent-payer-auth`). TAP does **not** move money by itself.

Compose:

1. Optional TAP middleware verifies agent HTTP identity (fail closed when `PAYMCP_TAP_REQUIRED=1`).
2. Paywall / listing `rail: "x402" | "visa" | "auto"` selects the settler.
3. `auto` prefers **visa** when a valid TAP signature is present **and** the Visa settler is configured; otherwise **x402**.
4. Settlement receipts include `rail` (`x402` or `visa`) in `PAYMENT-RESPONSE` and store public receipts.

## Modules

- `tapAgentMiddleware` + `createTapVerifier` — RFC 9421 verify (Ed25519 / RSA-PSS-SHA256), pluggable key lookup.
- `VisaVicSettler` — parallel to `FacilitatorSettler`; verify then settle; X-Pay token on each call.
- Paywall option `rail` + optional `visaSettler`; listing field `rail` in `@paymcp/store`.

## Env checklist (names only — set real values in your environment)

### TAP (identity)

- `PAYMCP_TAP_REQUIRED` — `1` to fail closed without valid TAP headers
- `PAYMCP_TAP_JWKS_URL` — agent public JWKS (Visa publishes `https://mcp.visa.com/.well-known/jwks`)
- `PAYMCP_TAP_JWKS_PATH` — optional local JWKS file for offline / pinned keys
- `PAYMCP_TAP_MAX_WINDOW_SECONDS` — optional; Visa guidance is ≤ 8 minutes

### Visa VIC settler (money movement)

Enable only when you have Visa Developer credentials:

- `PAYMCP_VISA_ENABLED` — must be `1` to boot the Visa rail
- `VISA_API_BASE_URL` — Visa API host for your project (sandbox or production)
- `VISA_API_KEY` — from Visa Developer project → X-Pay Token
- `VISA_SHARED_SECRET` — from the same credentials panel
- `VISA_KEY_ID` — optional
- `VISA_MERCHANT_ID` — optional
- `VISA_SETTLE_PATH` / `VISA_VERIFY_PATH` — optional overrides (defaults under `/vic/v1/payments/…`)
- `PAYMCP_VISA_TIMEOUT_MS` / `PAYMCP_VISA_MAX_RETRIES` — optional

If `PAYMCP_VISA_ENABLED=1` but API base / key / shared secret are unset, process boot **refuses** (`ConfigValidationError`).

### Unchanged x402 / store

Stripe funding, USDC payout, and x402 facilitator env (`PAYMCP_FACILITATOR_URL`, `PAYMCP_PAY_TO`, …) are unchanged.

## Offline vs live

| Capability | Offline (CI / unit tests) | Needs Visa developer credentials |
|------------|---------------------------|----------------------------------|
| TAP parse + Ed25519 verify | Yes (synthetic keys in tests only) | Live JWKS fetch from Visa |
| `VisaVicSettler` verify/settle | Yes (fixture `fetchImpl`) | Real `VISA_*` + sandbox/production API |
| Dual-rail paywall + receipt `rail` | Yes | Live VIC settle |
| Stripe / USDC / x402 | Existing fixtures | Existing live Base path |

## Client headers

- x402 rail: `PAYMENT-SIGNATURE` (existing)
- Visa rail: `VISA-PAYMENT` (base64url JSON `{ version: 1, amount, currency, merchantReference, credentialRef, … }`)
- TAP (either rail): `Signature-Input` + `Signature` per Visa TAP specs

## References

- [Trusted Agent Protocol](https://developer.visa.com/capabilities/trusted-agent-protocol/)
- [TAP specifications](https://developer.visa.com/capabilities/trusted-agent-protocol/trusted-agent-protocol-specifications/)
- [Visa Intelligent Commerce](https://developer.visa.com/capabilities/visa-intelligent-commerce)
- [X-Pay Token](https://developer.visa.com/pages/working-with-visa-apis/x-pay-token)
- Sample code: [visa/trusted-agent-protocol](https://github.com/visa/trusted-agent-protocol), [visa/ai](https://github.com/visa/ai)
