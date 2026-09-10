# Security Policy

## Supported versions

Security fixes are applied on the latest published `openapi-to-paymcp` release and on `main`.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security-sensitive reports.

Email **ranjan.shitole3129@gmail.com** with:

- A clear description of the issue and impact
- Steps to reproduce (PoC if available)
- Affected version / commit if known

We will acknowledge receipt and work with you on a fix and disclosure timeline.

## Handling payment material

Operators and contributors must never:

- Log full `PAYMENT-SIGNATURE` headers or decoded payment payloads
- Commit `.env`, private keys, facilitator JWTs, or CDP secrets
- Publish secrets inside the npm package (`files` is limited to `dist`, `bin`, and docs)

This codebase redacts `PAYMENT-SIGNATURE` and `Authorization` in structured logs. Keep that invariant when changing logging or error paths.

Settlement is **fail-closed**: facilitator transport errors, verify rejects, and unsuccessful settle responses must not grant access to paid routes or tools.
