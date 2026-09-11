import type { AgentTrace, PolicyViolation, TraceEvent } from "./schema.js";

const IDEMPOTENCY_HEADER = "idempotency-key";

/** Patterns that must never appear in agent/tool traces (align with sanitize.ts). */
const SECRET_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] =
  [
    {
      name: "PAYMENT-SIGNATURE",
      re: /PAYMENT-SIGNATURE\s*[:=]?\s*["']?[A-Za-z0-9+/=_-]{20,}/i,
    },
    { name: "Bearer token", re: /Bearer\s+[A-Za-z0-9._\-]{16,}/i },
    {
      name: "private key PEM",
      re: /-----BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY-----/,
    },
    {
      name: "long base64 blob",
      re: /\b[A-Za-z0-9+/]{80,}={0,2}\b/,
    },
    {
      name: "hex private key / seed",
      re: /\b(?:private[_-]?key|secret[_-]?key|seed)\s*[:=]\s*0x[a-fA-F0-9]{32,}\b/i,
    },
  ];

function headerLookup(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

function isSuccessStatus(code: number): boolean {
  return code >= 200 && code < 300;
}

/**
 * Evaluate a single agent trace against PayMCP production policies.
 * Returns all violations (does not short-circuit).
 */
export function evaluateTrace(trace: AgentTrace): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const events = trace.events;

  // Track last response status per operation for settle-before-success.
  const lastStatusByOp = new Map<string, number>();
  // Successful settles by idempotency key → event index of first success.
  const settledKeys = new Map<string, number>();

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    checkSecretLeak(event, i, violations);

    switch (event.type) {
      case "http_response":
        lastStatusByOp.set(event.operationId, event.statusCode);
        break;

      case "http_request": {
        // Paid settle path requires Idempotency-Key on the paid request.
        // We flag when amountAtomic is present (paid) and key is missing.
        if (event.amountAtomic !== undefined) {
          const key = headerLookup(event.headers, IDEMPOTENCY_HEADER);
          if (key === undefined || key.trim().length === 0) {
            violations.push({
              rule: "missing_idempotency_key",
              message: `Paid request for "${event.operationId}" is missing Idempotency-Key (required to prevent double-charge)`,
              eventIndex: i,
            });
          }
        }
        break;
      }

      case "settle": {
        const key = event.idempotencyKey?.trim();
        if (key === undefined || key.length === 0) {
          violations.push({
            rule: "missing_idempotency_key",
            message: `Settle for "${event.operationId}" has no idempotencyKey`,
            eventIndex: i,
          });
        } else if (event.success) {
          const prior = settledKeys.get(key);
          if (prior !== undefined) {
            violations.push({
              rule: "double_charge",
              message: `Idempotency-Key "${key}" settled successfully more than once (first at event ${prior}, again at ${i}) — production must replay, not re-settle`,
              eventIndex: i,
            });
          } else {
            settledKeys.set(key, i);
          }
        }

        const after =
          event.afterStatusCode ?? lastStatusByOp.get(event.operationId);
        if (after === undefined) {
          violations.push({
            rule: "settle_before_success",
            message: `Settle for "${event.operationId}" has no preceding 2xx response (settle must run only after successful handler reply)`,
            eventIndex: i,
          });
        } else if (!isSuccessStatus(after)) {
          violations.push({
            rule: "settle_before_success",
            message: `Settle for "${event.operationId}" after status ${after} — PayMCP settles only on 2xx`,
            eventIndex: i,
          });
        }
        break;
      }

      case "budget_check": {
        let max: bigint;
        let spent: bigint;
        let requested: bigint;
        try {
          max = BigInt(event.maxDailyAtomic);
          spent = BigInt(event.spentAtomic);
          requested = BigInt(event.requestedAtomic);
        } catch {
          violations.push({
            rule: "budget_overrun",
            message: `Budget check for "${event.operationId}" has non-integer atomic amounts`,
            eventIndex: i,
          });
          break;
        }
        const wouldExceed = spent + requested > max;
        if (wouldExceed && event.allowed) {
          violations.push({
            rule: "budget_overrun",
            message: `Budget overrun allowed for "${event.operationId}": spent ${spent.toString()} + requested ${requested.toString()} > max ${max.toString()}`,
            eventIndex: i,
          });
        }
        // Also flag traces that claim denied but numbers do not exceed (soft inconsistency).
        // Primary gate: never allow overspend.
        break;
      }

      default:
        break;
    }
  }

  return violations;
}

function checkSecretLeak(
  event: TraceEvent,
  eventIndex: number,
  violations: PolicyViolation[],
): void {
  const blobs: string[] = [];

  if (event.type === "log") {
    blobs.push(event.message);
  }
  if (event.type === "http_request" && event.headers !== undefined) {
    for (const [k, v] of Object.entries(event.headers)) {
      const lower = k.toLowerCase();
      // Headers that carry secrets should be summarized, not dumped raw.
      if (
        lower === "payment-signature" ||
        lower === "authorization" ||
        lower.includes("secret") ||
        lower.includes("private")
      ) {
        // Presence of full-looking values is a leak.
        if (v.length >= 16 && !v.includes("[REDACTED]")) {
          violations.push({
            rule: "secret_leak",
            message: `http_request headers contain unredacted secret field "${k}"`,
            eventIndex,
          });
        }
      }
      blobs.push(`${k}: ${v}`);
    }
  }

  for (const blob of blobs) {
    for (const pat of SECRET_PATTERNS) {
      if (pat.re.test(blob)) {
        violations.push({
          rule: "secret_leak",
          message: `Trace leaks ${pat.name} in ${event.type} event`,
          eventIndex,
        });
        // Avoid duplicate hits from overlapping patterns on same event.
        return;
      }
    }
  }
}

/** All rule ids the harness enforces (for docs / CLI --list-rules). */
export const POLICY_RULES: readonly {
  readonly id: import("./schema.js").PolicyRuleId;
  readonly summary: string;
}[] = [
  {
    id: "missing_idempotency_key",
    summary:
      "Paid requests and settle events must carry Idempotency-Key (no double-charge)",
  },
  {
    id: "settle_before_success",
    summary: "Settle only after a successful 2xx handler/upstream response",
  },
  {
    id: "double_charge",
    summary:
      "Same Idempotency-Key must not settle successfully twice (replay instead)",
  },
  {
    id: "budget_overrun",
    summary: "Traces must not allow spent+requested over per-tool daily max",
  },
  {
    id: "secret_leak",
    summary:
      "No PAYMENT-SIGNATURE, Bearer tokens, PEMs, or long secrets in trace logs/headers",
  },
];
