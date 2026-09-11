export type LedgerStatus = "pending" | "settled" | "failed" | "replayed";

export interface LedgerEntry {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly amount: string;
  readonly network: string;
  readonly payer: string;
  readonly transaction: string;
  readonly status: LedgerStatus;
  readonly errorReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Optional tenant for per-tenant budget tracking. */
  readonly tenantId: string | null;
}

export interface RecordSettlementInput {
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly amount: string;
  readonly network: string;
  readonly payer: string;
  readonly transaction: string;
  readonly status: Exclude<LedgerStatus, "pending" | "replayed">;
  readonly errorReason?: string;
  readonly tenantId?: string;
}

export interface BeginPendingInput {
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly amount: string;
  readonly network: string;
  readonly tenantId?: string;
}

export interface SumSettledInput {
  readonly operationId: string;
  /** Inclusive lower bound (ISO-8601). Only rows with created_at >= sinceIso. */
  readonly sinceIso: string;
  /** When set, only count rows for this tenant. When omitted, sum all tenants for the op. */
  readonly tenantId?: string;
}

/**
 * Result of atomically claiming an idempotency key for settlement.
 *
 * - `claimed` — this caller owns the in-flight attempt (pending row inserted or failed→pending reclaim)
 * - `already_settled` — key was settled; caller must skip settle and may replay prior PAYMENT-RESPONSE
 * - `in_flight` — another request holds pending; **fail closed** (do not start a second settle)
 */
export type BeginPendingResult =
  | { readonly kind: "claimed"; readonly entry: LedgerEntry }
  | { readonly kind: "already_settled"; readonly entry: LedgerEntry }
  | { readonly kind: "in_flight"; readonly entry: LedgerEntry };

/**
 * Settlement ledger — SQLite (default) or Postgres behind the same interface.
 * All methods are async so both backends share one call style.
 */
export interface Ledger {
  findByIdempotencyKey(key: string): Promise<LedgerEntry | undefined>;
  /**
   * Atomically reserve `idempotencyKey` as pending (UNIQUE constraint).
   * Only one concurrent caller wins; others see `in_flight` or `already_settled`.
   */
  beginPending(input: BeginPendingInput): Promise<BeginPendingResult>;
  recordSettlement(input: RecordSettlementInput): Promise<{
    entry: LedgerEntry;
    replayed: boolean;
  }>;
  countSettled(): Promise<number>;
  /**
   * Sum of `amount` for settled rows matching operationId (and optional tenant)
   * with created_at >= sinceIso. Used for per-tool daily budget hard-stops.
   */
  sumSettledAtomic(input: SumSettledInput): Promise<bigint>;
  /** True when the store is reachable (used by /readyz). */
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}
