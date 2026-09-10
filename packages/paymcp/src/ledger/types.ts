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

/**
 * Settlement ledger — SQLite (default) or Postgres behind the same interface.
 * All methods are async so both backends share one call style.
 */
export interface Ledger {
  findByIdempotencyKey(key: string): Promise<LedgerEntry | undefined>;
  recordSettlement(input: RecordSettlementInput): Promise<{
    entry: LedgerEntry;
    replayed: boolean;
  }>;
  countSettled(): Promise<number>;
  /** True when the store is reachable (used by /readyz). */
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}
