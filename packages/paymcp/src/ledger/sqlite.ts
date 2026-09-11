import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type {
  BeginPendingInput,
  BeginPendingResult,
  Ledger,
  LedgerEntry,
  LedgerStatus,
  RecordSettlementInput,
  SumSettledInput,
} from "./types.js";

export type {
  BeginPendingInput,
  BeginPendingResult,
  LedgerEntry,
  LedgerStatus,
  RecordSettlementInput,
  SumSettledInput,
} from "./types.js";

/**
 * Structured SQLite ledger with idempotency-key uniqueness.
 * Implements the shared async Ledger interface.
 *
 * Concurrent settle attempts for the same key: `beginPending` uses a UNIQUE
 * constraint inside an IMMEDIATE transaction so only one caller claims
 * `pending`; others get `in_flight` (fail closed) or `already_settled`.
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
        updated_at TEXT NOT NULL,
        tenant_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_operation ON ledger(operation_id);
      CREATE INDEX IF NOT EXISTS idx_ledger_status ON ledger(status);
      CREATE INDEX IF NOT EXISTS idx_ledger_op_created ON ledger(operation_id, created_at);
    `);
    // Migrate older DBs that lack tenant_id.
    const cols = this.db.prepare(`PRAGMA table_info(ledger)`).all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === "tenant_id")) {
      this.db.exec(`ALTER TABLE ledger ADD COLUMN tenant_id TEXT`);
    }
  }

  async findByIdempotencyKey(key: string): Promise<LedgerEntry | undefined> {
    return this.findSync(key);
  }

  async beginPending(input: BeginPendingInput): Promise<BeginPendingResult> {
    const claim = this.db.transaction(() => {
      const existing = this.findSync(input.idempotencyKey);
      if (existing !== undefined) {
        return this.resolveExistingForClaim(existing, input);
      }

      const now = new Date().toISOString();
      const id = randomUUID();
      try {
        this.db
          .prepare(
            `INSERT INTO ledger (
              id, idempotency_key, operation_id, amount, network, payer,
              transaction_hash, status, error_reason, created_at, updated_at,
              tenant_id
            ) VALUES (?, ?, ?, ?, ?, ?, '', 'pending', NULL, ?, ?, ?)`,
          )
          .run(
            id,
            input.idempotencyKey,
            input.operationId,
            input.amount,
            input.network,
            "",
            now,
            now,
            input.tenantId ?? null,
          );
      } catch (err) {
        if (!isUniqueConstraintError(err)) {
          throw err;
        }
        const raced = this.findSync(input.idempotencyKey);
        if (raced === undefined) {
          throw new Error("ledger unique race vanished");
        }
        return this.resolveExistingForClaim(raced, input);
      }

      const entry = this.findSync(input.idempotencyKey);
      if (entry === undefined) {
        throw new Error("ledger pending insert vanished");
      }
      return { kind: "claimed" as const, entry };
    });

    return claim();
  }

  /**
   * Insert or upgrade to settled/failed. Settled keys replay without overwrite.
   * Pending (and failed) rows are upgraded in place.
   */
  async recordSettlement(input: RecordSettlementInput): Promise<{
    entry: LedgerEntry;
    replayed: boolean;
  }> {
    const write = this.db.transaction(() => {
      const existing = this.findSync(input.idempotencyKey);
      if (existing !== undefined) {
        if (existing.status === "settled") {
          return { entry: existing, replayed: true };
        }
        return {
          entry: this.updateTerminal(input),
          replayed: false,
        };
      }

      const now = new Date().toISOString();
      const id = randomUUID();
      try {
        this.db
          .prepare(
            `INSERT INTO ledger (
              id, idempotency_key, operation_id, amount, network, payer,
              transaction_hash, status, error_reason, created_at, updated_at,
              tenant_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            input.tenantId ?? null,
          );
      } catch (err) {
        if (!isUniqueConstraintError(err)) {
          throw err;
        }
        const raced = this.findSync(input.idempotencyKey);
        if (raced === undefined) {
          throw new Error("ledger insert race vanished");
        }
        if (raced.status === "settled") {
          return { entry: raced, replayed: true };
        }
        return {
          entry: this.updateTerminal(input),
          replayed: false,
        };
      }

      const entry = this.findSync(input.idempotencyKey);
      if (entry === undefined) {
        throw new Error("ledger insert vanished");
      }
      return { entry, replayed: false };
    });

    return write();
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

  async sumSettledAtomic(input: SumSettledInput): Promise<bigint> {
    let sql = `SELECT amount FROM ledger
      WHERE status = 'settled' AND operation_id = ? AND created_at >= ?`;
    const params: unknown[] = [input.operationId, input.sinceIso];
    if (input.tenantId !== undefined) {
      sql += ` AND tenant_id = ?`;
      params.push(input.tenantId);
    }
    const rows = this.db.prepare(sql).all(...params) as Array<{ amount: unknown }>;
    let total = 0n;
    for (const row of rows) {
      if (typeof row.amount === "string" && /^\d+$/.test(row.amount)) {
        total += BigInt(row.amount);
      }
    }
    return total;
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

  private findSync(key: string): LedgerEntry | undefined {
    const row = this.db
      .prepare(
        `SELECT id, idempotency_key, operation_id, amount, network, payer,
                transaction_hash, status, error_reason, created_at, updated_at,
                tenant_id
         FROM ledger WHERE idempotency_key = ?`,
      )
      .get(key);
    if (row === undefined) {
      return undefined;
    }
    return mapRow(row);
  }

  private resolveExistingForClaim(
    existing: LedgerEntry,
    input: BeginPendingInput,
  ): BeginPendingResult {
    if (existing.status === "settled") {
      return { kind: "already_settled", entry: existing };
    }
    if (existing.status === "pending") {
      return { kind: "in_flight", entry: existing };
    }

    // Reclaim failed/replayed so the same key can be safely retried.
    const updatedAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE ledger SET status = 'pending', transaction_hash = '', payer = '',
         error_reason = NULL, updated_at = ?,
         operation_id = ?, amount = ?, network = ?, tenant_id = ?
         WHERE idempotency_key = ? AND status IN ('failed', 'replayed')`,
      )
      .run(
        updatedAt,
        input.operationId,
        input.amount,
        input.network,
        input.tenantId ?? null,
        input.idempotencyKey,
      );
    if (result.changes === 0) {
      const again = this.findSync(input.idempotencyKey);
      if (again === undefined) {
        throw new Error("ledger reclaim vanished");
      }
      if (again.status === "settled") {
        return { kind: "already_settled", entry: again };
      }
      return { kind: "in_flight", entry: again };
    }
    const refreshed = this.findSync(input.idempotencyKey);
    if (refreshed === undefined) {
      throw new Error("ledger reclaim refresh vanished");
    }
    return { kind: "claimed", entry: refreshed };
  }

  private updateTerminal(input: RecordSettlementInput): LedgerEntry {
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE ledger SET status = ?, transaction_hash = ?, payer = ?,
         error_reason = ?, updated_at = ?,
         operation_id = ?, amount = ?, network = ?, tenant_id = COALESCE(?, tenant_id)
         WHERE idempotency_key = ?`,
      )
      .run(
        input.status,
        input.transaction,
        input.payer,
        input.errorReason ?? null,
        updatedAt,
        input.operationId,
        input.amount,
        input.network,
        input.tenantId ?? null,
        input.idempotencyKey,
      );
    const refreshed = this.findSync(input.idempotencyKey);
    if (refreshed === undefined) {
      throw new Error("ledger update vanished");
    }
    return refreshed;
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
  tenant_id?: unknown;
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
    tenantId:
      row.tenant_id === null || row.tenant_id === undefined
        ? null
        : asString(row.tenant_id),
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

function isUniqueConstraintError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT";
}
