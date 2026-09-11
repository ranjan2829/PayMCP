import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Ledger, LedgerEntry } from "../ledger/types.js";

/** Dispute pack schema version (embedded in every export). */
export const DISPUTE_PACK_VERSION = 1 as const;

/**
 * Policy note shipped with every pack. Clarifies evidence scope and that
 * PAYMENT-SIGNATURE payloads are never exported.
 */
export const DISPUTE_PACK_POLICY_NOTE =
  "PayMCP chargeback evidence pack v1: settled ledger attempts only " +
  "(operationId, amount, network, payer, tx, idempotency key, timestamps). " +
  "Full PAYMENT-SIGNATURE / PaymentPayload bodies are never included. " +
  "Verify contentHash (SHA-256 of canonical unsigned body) and HMAC-SHA256 signature.";

export const DISPUTE_HMAC_ENV = "PAYMCP_DISPUTE_HMAC_SECRET";

/** Settled attempt row safe for chargeback / evidence export. */
export interface DisputePackAttempt {
  readonly operationId: string;
  readonly amount: string;
  readonly network: string;
  readonly payer: string;
  /** On-chain / facilitator transaction hash (ledger `transaction`). */
  readonly transaction: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Unsigned body hashed into `contentHash`. Signature is computed over
 * `contentHash` (hex) with HMAC-SHA256.
 */
export interface DisputePackBody {
  readonly version: typeof DISPUTE_PACK_VERSION;
  readonly policyNote: string;
  /** Inclusive lower bound (ISO-8601) used for the query. */
  readonly from: string;
  /** Inclusive upper bound (ISO-8601) used for the query. */
  readonly to: string;
  readonly exportedAt: string;
  readonly attempts: readonly DisputePackAttempt[];
}

export interface DisputePackSignature {
  readonly alg: "HMAC-SHA256";
  /** Hex-encoded HMAC-SHA256 over `contentHash`. */
  readonly value: string;
}

/** Signed dispute / evidence pack written to disk or returned from the library. */
export interface DisputePack {
  readonly version: typeof DISPUTE_PACK_VERSION;
  readonly policyNote: string;
  readonly from: string;
  readonly to: string;
  readonly exportedAt: string;
  readonly attempts: readonly DisputePackAttempt[];
  /** SHA-256 hex of canonical JSON of the unsigned body fields. */
  readonly contentHash: string;
  readonly signature: DisputePackSignature;
}

export interface ExportDisputePackInput {
  readonly ledger: Ledger;
  /** Inclusive ISO-8601 lower bound (`created_at >= from`). */
  readonly from: string;
  /** Inclusive ISO-8601 upper bound (`created_at <= to`). */
  readonly to: string;
  /** HMAC secret (typically `process.env.PAYMCP_DISPUTE_HMAC_SECRET`). */
  readonly hmacSecret: string;
  /** Override `exportedAt` (ISO-8601); defaults to now. */
  readonly exportedAt?: string;
}

const ATTEMPT_KEYS = [
  "amount",
  "createdAt",
  "idempotencyKey",
  "network",
  "operationId",
  "payer",
  "transaction",
  "updatedAt",
] as const;

/**
 * Export a signed chargeback-ready dispute pack from settled ledger rows.
 * Never includes PAYMENT-SIGNATURE / PaymentPayload material.
 */
export async function exportDisputePack(
  input: ExportDisputePackInput,
): Promise<DisputePack> {
  assertIsoBound(input.from, "--from / from");
  assertIsoBound(input.to, "--to / to");
  if (input.from > input.to) {
    throw new Error(`from (${input.from}) must be <= to (${input.to})`);
  }
  const secret = input.hmacSecret.trim();
  if (secret.length < 16) {
    throw new Error(
      `${DISPUTE_HMAC_ENV} must be set to a secret of at least 16 characters`,
    );
  }

  const entries = await input.ledger.listSettledInRange({
    fromIso: input.from,
    toIso: input.to,
  });
  const attempts = entries.map(toAttempt);
  const exportedAt = input.exportedAt ?? new Date().toISOString();

  const body: DisputePackBody = {
    version: DISPUTE_PACK_VERSION,
    policyNote: DISPUTE_PACK_POLICY_NOTE,
    from: input.from,
    to: input.to,
    exportedAt,
    attempts,
  };

  assertNoPaymentSignatureMaterial(body);

  const contentHash = hashDisputePackBody(body);
  const signatureValue = signContentHash(contentHash, secret);

  return {
    ...body,
    contentHash,
    signature: {
      alg: "HMAC-SHA256",
      value: signatureValue,
    },
  };
}

/** SHA-256 hex of the canonical JSON for an unsigned dispute pack body. */
export function hashDisputePackBody(body: DisputePackBody): string {
  const canonical = canonicalJson({
    version: body.version,
    policyNote: body.policyNote,
    from: body.from,
    to: body.to,
    exportedAt: body.exportedAt,
    attempts: body.attempts,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** HMAC-SHA256 (hex) of `contentHash` using the dispute secret. */
export function signContentHash(contentHash: string, hmacSecret: string): string {
  return createHmac("sha256", hmacSecret)
    .update(contentHash, "utf8")
    .digest("hex");
}

/**
 * Verify pack integrity: recompute contentHash from body fields and check
 * HMAC-SHA256(signature) against the secret. Timing-safe compare.
 */
export function verifyDisputePackSignature(
  pack: DisputePack,
  hmacSecret: string,
): boolean {
  const secret = hmacSecret.trim();
  if (secret.length === 0) {
    return false;
  }
  if (pack.signature.alg !== "HMAC-SHA256") {
    return false;
  }

  const body: DisputePackBody = {
    version: pack.version,
    policyNote: pack.policyNote,
    from: pack.from,
    to: pack.to,
    exportedAt: pack.exportedAt,
    attempts: pack.attempts,
  };

  const expectedHash = hashDisputePackBody(body);
  if (!safeEqualHex(expectedHash, pack.contentHash)) {
    return false;
  }

  const expectedSig = signContentHash(expectedHash, secret);
  return safeEqualHex(expectedSig, pack.signature.value);
}

/** Map a settled ledger entry to the export-safe attempt shape. */
export function toAttempt(entry: LedgerEntry): DisputePackAttempt {
  return {
    operationId: entry.operationId,
    amount: entry.amount,
    network: entry.network,
    payer: entry.payer,
    transaction: entry.transaction,
    idempotencyKey: entry.idempotencyKey,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/**
 * Deterministic JSON for hashing: sorted object keys, arrays preserve order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys(obj[key]);
    }
    return out;
  }
  return value;
}

function assertIsoBound(value: string, label: string): void {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} requires an ISO-8601 timestamp`);
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new Error(`${label} must be a valid ISO-8601 timestamp (got ${value})`);
  }
}

/**
 * Defense in depth: refuse to export if any string field looks like a full
 * PAYMENT-SIGNATURE / long PaymentPayload blob.
 */
function assertNoPaymentSignatureMaterial(body: DisputePackBody): void {
  // Scan attempt fields only — policyNote intentionally mentions PAYMENT-SIGNATURE.
  for (const attempt of body.attempts) {
    for (const key of Object.keys(attempt)) {
      if (!ATTEMPT_KEYS.includes(key as (typeof ATTEMPT_KEYS)[number])) {
        throw new Error(`refusing to export pack: unexpected attempt field ${key}`);
      }
    }
    const blob = canonicalJson(attempt);
    if (/PAYMENT-SIGNATURE/i.test(blob)) {
      throw new Error(
        "refusing to export pack: PAYMENT-SIGNATURE material detected in attempt fields",
      );
    }
    // Long base64-like runs are typical of encoded PaymentPayload headers.
    if (/\b[A-Za-z0-9+/]{80,}={0,2}\b/.test(blob)) {
      throw new Error(
        "refusing to export pack: long base64 blob looks like a PAYMENT-SIGNATURE payload",
      );
    }
  }
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length === 0 || ba.length !== bb.length) {
      return false;
    }
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}
