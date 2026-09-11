import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type {
  BeginPendingInput,
  BeginPendingResult,
  Ledger,
  LedgerEntry,
  LedgerStatus,
  ListSettledRangeInput,
  RecordSettlementInput,
  SumSettledInput,
} from "./types.js";

type PgPool = {
  query: (
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  connect: () => Promise<PgPoolClient>;
  end: () => Promise<void>;
};

type PgPoolClient = {
  query: (
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release: () => void;
};

type PgModule = {
  Pool: new (cfg: { connectionString: string }) => PgPool;
  default?: { Pool: new (cfg: { connectionString: string }) => PgPool };
};

/**
 * Postgres ledger behind the same Ledger interface as SqliteLedger.
 * Requires the optional `pg` dependency at runtime.
 *
 * `beginPending` runs in a transaction with UNIQUE(idempotency_key) so only
 * one concurrent settle claim wins.
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
        updated_at TIMESTAMPTZ NOT NULL,
        tenant_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_operation ON ledger(operation_id);
      CREATE INDEX IF NOT EXISTS idx_ledger_status ON ledger(status);
      CREATE INDEX IF NOT EXISTS idx_ledger_op_created ON ledger(operation_id, created_at);
    `);
    await this.pool.query(`
      ALTER TABLE ledger ADD COLUMN IF NOT EXISTS tenant_id TEXT
    `);
    this.migrated = true;
  }

  async findByIdempotencyKey(key: string): Promise<LedgerEntry | undefined> {
    await this.ensureMigrated();
    const result = await this.pool.query(
      `SELECT id, idempotency_key, operation_id, amount, network, payer,
              transaction_hash, status, error_reason, created_at, updated_at,
              tenant_id
       FROM ledger WHERE idempotency_key = $1`,
      [key],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return mapRow(row);
  }

  async beginPending(input: BeginPendingInput): Promise<BeginPendingResult> {
    await this.ensureMigrated();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existingResult = await client.query(
        `SELECT id, idempotency_key, operation_id, amount, network, payer,
                transaction_hash, status, error_reason, created_at, updated_at,
                tenant_id
         FROM ledger WHERE idempotency_key = $1 FOR UPDATE`,
        [input.idempotencyKey],
      );
      const existingRow = existingResult.rows[0];
      if (existingRow !== undefined) {
        const result = await resolveExistingForClaim(client, mapRow(existingRow), input);
        await client.query("COMMIT");
        return result;
      }

      const now = new Date().toISOString();
      const id = randomUUID();
      try {
        await client.query(
          `INSERT INTO ledger (
            id, idempotency_key, operation_id, amount, network, payer,
            transaction_hash, status, error_reason, created_at, updated_at,
            tenant_id
          ) VALUES ($1,$2,$3,$4,$5,'','','pending',NULL,$6,$7,$8)`,
          [
            id,
            input.idempotencyKey,
            input.operationId,
            input.amount,
            input.network,
            now,
            now,
            input.tenantId ?? null,
          ],
        );
      } catch (err) {
        await client.query("ROLLBACK");
        if (!isUniqueViolation(err)) {
          throw err;
        }
        const raced = await this.findByIdempotencyKey(input.idempotencyKey);
        if (raced === undefined) {
          throw new Error("ledger unique race vanished");
        }
        if (raced.status === "settled") {
          return { kind: "already_settled", entry: raced };
        }
        return { kind: "in_flight", entry: raced };
      }

      const entryResult = await client.query(
        `SELECT id, idempotency_key, operation_id, amount, network, payer,
                transaction_hash, status, error_reason, created_at, updated_at,
                tenant_id
         FROM ledger WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      const entryRow = entryResult.rows[0];
      if (entryRow === undefined) {
        await client.query("ROLLBACK");
        throw new Error("ledger pending insert vanished");
      }
      await client.query("COMMIT");
      return { kind: "claimed", entry: mapRow(entryRow) };
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback errors
      }
      throw err;
    } finally {
      client.release();
    }
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
      const updatedAt = new Date().toISOString();
      await this.pool.query(
        `UPDATE ledger SET status = $1, transaction_hash = $2, payer = $3,
         error_reason = $4, updated_at = $5,
         operation_id = $6, amount = $7, network = $8,
         tenant_id = COALESCE($9, tenant_id)
         WHERE idempotency_key = $10`,
        [
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
        ],
      );
      const refreshed = await this.findByIdempotencyKey(input.idempotencyKey);
      if (refreshed === undefined) {
        throw new Error("ledger update vanished");
      }
      return { entry: refreshed, replayed: false };
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    try {
      await this.pool.query(
        `INSERT INTO ledger (
          id, idempotency_key, operation_id, amount, network, payer,
          transaction_hash, status, error_reason, created_at, updated_at,
          tenant_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
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
          input.tenantId ?? null,
        ],
      );
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      const raced = await this.findByIdempotencyKey(input.idempotencyKey);
      if (raced === undefined) {
        throw new Error("ledger insert race vanished");
      }
      if (raced.status === "settled") {
        return { entry: raced, replayed: true };
      }
      const updatedAt = new Date().toISOString();
      await this.pool.query(
        `UPDATE ledger SET status = $1, transaction_hash = $2, payer = $3,
         error_reason = $4, updated_at = $5 WHERE idempotency_key = $6`,
        [
          input.status,
          input.transaction,
          input.payer,
          input.errorReason ?? null,
          updatedAt,
          input.idempotencyKey,
        ],
      );
      const refreshed = await this.findByIdempotencyKey(input.idempotencyKey);
      if (refreshed === undefined) {
        throw new Error("ledger race update vanished");
      }
      return { entry: refreshed, replayed: false };
    }

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

  async sumSettledAtomic(input: SumSettledInput): Promise<bigint> {
    await this.ensureMigrated();
    const params: unknown[] = [input.operationId, input.sinceIso];
    let sql = `SELECT amount FROM ledger
      WHERE status = 'settled' AND operation_id = $1 AND created_at >= $2::timestamptz`;
    if (input.tenantId !== undefined) {
      sql += ` AND tenant_id = $3`;
      params.push(input.tenantId);
    }
    const result = await this.pool.query(sql, params);
    let total = 0n;
    for (const row of result.rows) {
      const amount = row["amount"];
      if (typeof amount === "string" && /^\d+$/.test(amount)) {
        total += BigInt(amount);
      }
    }
    return total;
  }


  async listSettledInRange(
    input: ListSettledRangeInput,
  ): Promise<readonly LedgerEntry[]> {
    await this.ensureMigrated();
    const result = await this.pool.query(
      `SELECT id, idempotency_key, operation_id, amount, network, payer,
              transaction_hash, status, error_reason, created_at, updated_at,
              tenant_id
       FROM ledger
       WHERE status = 'settled'
         AND created_at >= $1::timestamptz
         AND created_at <= $2::timestamptz
       ORDER BY created_at ASC, idempotency_key ASC`,
      [input.fromIso, input.toIso],
    );
    return result.rows.map((row) => mapRow(row));
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

async function resolveExistingForClaim(
  client: PgPoolClient,
  existing: LedgerEntry,
  input: BeginPendingInput,
): Promise<BeginPendingResult> {
  if (existing.status === "settled") {
    return { kind: "already_settled", entry: existing };
  }
  if (existing.status === "pending") {
    return { kind: "in_flight", entry: existing };
  }

  const updatedAt = new Date().toISOString();
  const updated = await client.query(
    `UPDATE ledger SET status = 'pending', transaction_hash = '', payer = '',
     error_reason = NULL, updated_at = $1,
     operation_id = $2, amount = $3, network = $4, tenant_id = $5
     WHERE idempotency_key = $6 AND status IN ('failed', 'replayed')
     RETURNING id, idempotency_key, operation_id, amount, network, payer,
               transaction_hash, status, error_reason, created_at, updated_at,
               tenant_id`,
    [
      updatedAt,
      input.operationId,
      input.amount,
      input.network,
      input.tenantId ?? null,
      input.idempotencyKey,
    ],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    const again = await client.query(
      `SELECT id, idempotency_key, operation_id, amount, network, payer,
              transaction_hash, status, error_reason, created_at, updated_at,
              tenant_id
       FROM ledger WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    const againRow = again.rows[0];
    if (againRow === undefined) {
      throw new Error("ledger reclaim vanished");
    }
    const entry = mapRow(againRow);
    if (entry.status === "settled") {
      return { kind: "already_settled", entry };
    }
    return { kind: "in_flight", entry };
  }
  return { kind: "claimed", entry: mapRow(row) };
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
    tenantId:
      row["tenant_id"] === null || row["tenant_id"] === undefined
        ? null
        : asString(row["tenant_id"]),
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

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return code === "23505";
}
