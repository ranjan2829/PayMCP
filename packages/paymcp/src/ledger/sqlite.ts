import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type {
  Ledger,
  LedgerEntry,
  LedgerStatus,
  RecordSettlementInput,
} from "./types.js";

export type { LedgerEntry, LedgerStatus, RecordSettlementInput } from "./types.js";

/**
 * Structured SQLite ledger with idempotency-key uniqueness.
 * Implements the shared async Ledger interface.
 */
export class SqliteLedger implements Ledger {
  private readonly db: Database.Database;

  constructor(path: string = "./paymcp-ledger.db") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledger (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        operation_id TEXT NOT NULL,
        amount TEXT NOT NULL,
        network TEXT NOT NULL,
        payer TEXT NOT NULL,
        transaction_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        error_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_operation ON ledger(operation_id);
      CREATE INDEX IF NOT EXISTS idx_ledger_status ON ledger(status);
    `);
  }

  async findByIdempotencyKey(key: string): Promise<LedgerEntry | undefined> {
    const row = this.db
      .prepare(
        `SELECT id, idempotency_key, operation_id, amount, network, payer,
                transaction_hash, status, error_reason, created_at, updated_at
         FROM ledger WHERE idempotency_key = ?`,
      )
      .get(key);
    if (row === undefined) {
      return undefined;
    }
    return mapRow(row);
  }

  /**
   * Insert a settled/failed row. If the idempotency key already exists with
   * status settled, returns the existing entry (replay). Conflicts on failed
   * → settled upgrades are allowed only when previous status was failed.
   */
  async recordSettlement(input: RecordSettlementInput): Promise<{
    entry: LedgerEntry;
    replayed: boolean;
  }> {
    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (existing !== undefined) {
      if (existing.status === "settled") {
        return { entry: existing, replayed: true };
      }
      if (existing.status === "failed" && input.status === "settled") {
        const updatedAt = new Date().toISOString();
        this.db
          .prepare(
            `UPDATE ledger SET status = ?, transaction_hash = ?, payer = ?,
             error_reason = NULL, updated_at = ? WHERE idempotency_key = ?`,
          )
          .run(
            input.status,
            input.transaction,
            input.payer,
            updatedAt,
            input.idempotencyKey,
          );
        const refreshed = await this.findByIdempotencyKey(input.idempotencyKey);
        if (refreshed === undefined) {
          throw new Error("ledger update vanished");
        }
        return { entry: refreshed, replayed: false };
      }
      return { entry: existing, replayed: true };
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO ledger (
          id, idempotency_key, operation_id, amount, network, payer,
          transaction_hash, status, error_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.idempotencyKey,
        input.operationId,
        input.amount,
        input.network,
        input.payer,
        input.transaction,
        input.status,
        input.errorReason ?? null,
        now,
        now,
      );
    const entry = await this.findByIdempotencyKey(input.idempotencyKey);
    if (entry === undefined) {
      throw new Error("ledger insert vanished");
    }
    return { entry, replayed: false };
  }

  async countSettled(): Promise<number> {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM ledger WHERE status = 'settled'`)
      .get();
    if (!isCountRow(row)) {
      return 0;
    }
    return row.c;
  }

  async isReady(): Promise<boolean> {
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export function deriveIdempotencyKey(parts: {
  readonly operationId: string;
  readonly paymentSignatureHeader: string;
}): string {
  const h = createHash("sha256");
  h.update(parts.operationId);
  h.update("\0");
  h.update(parts.paymentSignatureHeader);
  return h.digest("hex");
}

interface RawRow {
  id: unknown;
  idempotency_key: unknown;
  operation_id: unknown;
  amount: unknown;
  network: unknown;
  payer: unknown;
  transaction_hash: unknown;
  status: unknown;
  error_reason: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function mapRow(row: unknown): LedgerEntry {
  if (!isRawRow(row)) {
    throw new Error("unexpected ledger row shape");
  }
  const status = row.status;
  if (
    status !== "pending" &&
    status !== "settled" &&
    status !== "failed" &&
    status !== "replayed"
  ) {
    throw new Error(`unknown ledger status: ${String(status)}`);
  }
  return {
    id: asString(row.id),
    idempotencyKey: asString(row.idempotency_key),
    operationId: asString(row.operation_id),
    amount: asString(row.amount),
    network: asString(row.network),
    payer: asString(row.payer),
    transaction: asString(row.transaction_hash),
    status,
    errorReason:
      row.error_reason === null ? null : asString(row.error_reason),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function isRawRow(row: unknown): row is RawRow {
  return typeof row === "object" && row !== null;
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("expected string column");
  }
  return value;
}

function isCountRow(row: unknown): row is { c: number } {
  return (
    typeof row === "object" &&
    row !== null &&
    "c" in row &&
    typeof (row as { c: unknown }).c === "number"
  );
}
