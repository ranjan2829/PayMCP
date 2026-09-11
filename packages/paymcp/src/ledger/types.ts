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
}

export interface BeginPendingInput {
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly amount: string;
  readonly network: string;
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
  /** True when the store is reachable (used by /readyz). */
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}
