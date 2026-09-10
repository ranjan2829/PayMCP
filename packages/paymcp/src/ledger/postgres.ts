import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type {
  Ledger,
  LedgerEntry,
  LedgerStatus,
  RecordSettlementInput,
} from "./types.js";

type PgPool = {
  query: (
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
  end: () => Promise<void>;
};

type PgModule = {
  Pool: new (cfg: { connectionString: string }) => PgPool;
  default?: { Pool: new (cfg: { connectionString: string }) => PgPool };
};

/**
 * Postgres ledger behind the same Ledger interface as SqliteLedger.
 * Requires the optional `pg` dependency at runtime.
 */
export class PostgresLedger implements Ledger {
  private readonly pool: PgPool;
  private migrated = false;

  constructor(databaseUrl: string) {
    let PoolCtor: new (cfg: { connectionString: string }) => PgPool;
    try {
      const req = createRequire(import.meta.url);
      const mod = req("pg") as PgModule;
      PoolCtor = mod.Pool ?? mod.default!.Pool;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `PAYMCP_DATABASE_URL is set but the \`pg\` package could not be loaded (${detail}). Run: pnpm add pg`,
      );
    }
    this.pool = new PoolCtor({ connectionString: databaseUrl });
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
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
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_operation ON ledger(operation_id);
      CREATE INDEX IF NOT EXISTS idx_ledger_status ON ledger(status);
    `);
    this.migrated = true;
  }

  async findByIdempotencyKey(key: string): Promise<LedgerEntry | undefined> {
    await this.ensureMigrated();
    const result = await this.pool.query(
      `SELECT id, idempotency_key, operation_id, amount, network, payer,
              transaction_hash, status, error_reason, created_at, updated_at
       FROM ledger WHERE idempotency_key = $1`,
      [key],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return mapRow(row);
  }

  async recordSettlement(input: RecordSettlementInput): Promise<{
    entry: LedgerEntry;
    replayed: boolean;
  }> {
    await this.ensureMigrated();
    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (existing !== undefined) {
      if (existing.status === "settled") {
        return { entry: existing, replayed: true };
      }
      if (existing.status === "failed" && input.status === "settled") {
        const updatedAt = new Date().toISOString();
        await this.pool.query(
          `UPDATE ledger SET status = $1, transaction_hash = $2, payer = $3,
           error_reason = NULL, updated_at = $4 WHERE idempotency_key = $5`,
          [
            input.status,
            input.transaction,
            input.payer,
            updatedAt,
            input.idempotencyKey,
          ],
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
    await this.pool.query(
      `INSERT INTO ledger (
        id, idempotency_key, operation_id, amount, network, payer,
        transaction_hash, status, error_reason, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
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
      ],
    );
    const entry = await this.findByIdempotencyKey(input.idempotencyKey);
    if (entry === undefined) {
      throw new Error("ledger insert vanished");
    }
    return { entry, replayed: false };
  }

  async countSettled(): Promise<number> {
    await this.ensureMigrated();
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS c FROM ledger WHERE status = 'settled'`,
    );
    const c = result.rows[0]?.["c"];
    return typeof c === "number" ? c : 0;
  }

  async isReady(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async ensureMigrated(): Promise<void> {
    if (!this.migrated) {
      await this.migrate();
    }
  }
}

function mapRow(row: Record<string, unknown>): LedgerEntry {
  const status = row["status"];
  if (
    status !== "pending" &&
    status !== "settled" &&
    status !== "failed" &&
    status !== "replayed"
  ) {
    throw new Error(`unknown ledger status: ${String(status)}`);
  }
  return {
    id: asString(row["id"]),
    idempotencyKey: asString(row["idempotency_key"]),
    operationId: asString(row["operation_id"]),
    amount: asString(row["amount"]),
    network: asString(row["network"]),
    payer: asString(row["payer"]),
    transaction: asString(row["transaction_hash"]),
    status: status as LedgerStatus,
    errorReason:
      row["error_reason"] === null || row["error_reason"] === undefined
        ? null
        : asString(row["error_reason"]),
    createdAt: asIso(row["created_at"]),
    updatedAt: asIso(row["updated_at"]),
  };
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("expected string column");
  }
  return value;
}

function asIso(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  throw new Error("expected timestamp column");
}
