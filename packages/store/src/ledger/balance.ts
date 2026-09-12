import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { StoreError } from "../errors/index.js";
import {
  BalanceSchema,
  SpendLogEntrySchema,
  SpendLogQuerySchema,
  TopUpInputSchema,
  type Balance,
  type SpendLogEntry,
  type SpendLogQuery,
  type TopUpInput,
} from "./schemas.js";

interface BalanceRow {
  buyer_id: string;
  balance: string;
  updated_at: string;
}

interface SpendRow {
  id: string;
  buyer_id: string;
  listing_id: string;
  amount: string;
  idempotency_key: string;
  request_id: string | null;
  status: string;
  upstream_status: number | null;
  error_reason: string | null;
  created_at: string;
  updated_at: string;
}

export type BeginSpendResult =
  | { readonly kind: "claimed"; readonly entry: SpendLogEntry }
  | { readonly kind: "already_settled"; readonly entry: SpendLogEntry }
  | { readonly kind: "in_flight"; readonly entry: SpendLogEntry };

export interface BeginSpendInput {
  readonly buyerId: string;
  readonly listingId: string;
  readonly amount: string;
  readonly idempotencyKey: string;
  readonly requestId?: string;
}

export interface CompleteSpendInput {
  readonly idempotencyKey: string;
  readonly status: "settled" | "failed";
  readonly upstreamStatus?: number;
  readonly errorReason?: string;
}

/**
 * Buyer credit ledger: top-up, atomic debit-after-success, spend log.
 *
 * Happy path agents spend from balance — no EVM_PRIVATE_KEY required.
 * Debit is reserved (pending) before upstream invoke and finalized only
 * after 2xx (mirror settle-on-200). Failed upstream releases the hold.
 */
export class BuyerBalanceLedger {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS buyer_balances (
        buyer_id TEXT PRIMARY KEY,
        balance TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS spend_log (
        id TEXT PRIMARY KEY,
        buyer_id TEXT NOT NULL,
        listing_id TEXT NOT NULL,
        amount TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_id TEXT,
        status TEXT NOT NULL,
        upstream_status INTEGER,
        error_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_spend_buyer ON spend_log(buyer_id);
      CREATE INDEX IF NOT EXISTS idx_spend_listing ON spend_log(listing_id);
      CREATE INDEX IF NOT EXISTS idx_spend_status ON spend_log(status);
    `);
  }

  getBalance(buyerId: string): Balance {
    const row = this.db
      .prepare(
        `SELECT buyer_id, balance, updated_at FROM buyer_balances WHERE buyer_id = ?`,
      )
      .get(buyerId) as BalanceRow | undefined;
    if (row === undefined) {
      return BalanceSchema.parse({
        buyerId,
        balance: "0",
        updatedAt: new Date().toISOString(),
      });
    }
    return BalanceSchema.parse({
      buyerId: row.buyer_id,
      balance: row.balance,
      updatedAt: row.updated_at,
    });
  }

  /** Dev / MVP top-up faucet. Credits buyer balance atomically. */
  topUp(input: TopUpInput): Balance {
    const parsed = TopUpInputSchema.parse(input);
    const now = new Date().toISOString();
    const amount = BigInt(parsed.amount);

    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT buyer_id, balance, updated_at FROM buyer_balances WHERE buyer_id = ?`,
        )
        .get(parsed.buyerId) as BalanceRow | undefined;

      if (row === undefined) {
        this.db
          .prepare(
            `INSERT INTO buyer_balances (buyer_id, balance, updated_at) VALUES (?, ?, ?)`,
          )
          .run(parsed.buyerId, parsed.amount, now);
      } else {
        const next = (BigInt(row.balance) + amount).toString();
        this.db
          .prepare(
            `UPDATE buyer_balances SET balance = ?, updated_at = ? WHERE buyer_id = ?`,
          )
          .run(next, now, parsed.buyerId);
      }
    });
    tx();
    return this.getBalance(parsed.buyerId);
  }

  /**
   * Atomically reserve spend: check balance, insert pending spend_log,
   * decrement available (hold). UNIQUE on idempotency_key.
   */
  beginSpend(input: BeginSpendInput): BeginSpendResult {
    const amount = BigInt(input.amount);
    if (amount <= 0n) {
      throw new StoreError("VALIDATION", "spend amount must be > 0", 400);
    }

    const claim = this.db.transaction((): BeginSpendResult => {
      const existing = this.findSpendByIdem(input.idempotencyKey);
      if (existing !== undefined) {
        if (existing.status === "settled") {
          return { kind: "already_settled", entry: existing };
        }
        if (existing.status === "pending") {
          return { kind: "in_flight", entry: existing };
        }
        return this.reclaimFailed(existing, input);
      }

      const balRow = this.db
        .prepare(
          `SELECT buyer_id, balance, updated_at FROM buyer_balances WHERE buyer_id = ?`,
        )
        .get(input.buyerId) as BalanceRow | undefined;
      const current = balRow !== undefined ? BigInt(balRow.balance) : 0n;
      if (current < amount) {
        throw new StoreError(
          "INSUFFICIENT_BALANCE",
          `insufficient balance: have ${current.toString()}, need ${input.amount}`,
          402,
          {
            buyerId: input.buyerId,
            balance: current.toString(),
            required: input.amount,
          },
        );
      }
      if (balRow === undefined) {
        throw new StoreError("INSUFFICIENT_BALANCE", "no balance row", 402);
      }

      const now = new Date().toISOString();
      const nextBal = (current - amount).toString();
      this.db
        .prepare(
          `UPDATE buyer_balances SET balance = ?, updated_at = ? WHERE buyer_id = ?`,
        )
        .run(nextBal, now, input.buyerId);

      const id = randomUUID();
      try {
        this.db
          .prepare(
            `INSERT INTO spend_log (
              id, buyer_id, listing_id, amount, idempotency_key, request_id,
              status, upstream_status, error_reason, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
          )
          .run(
            id,
            input.buyerId,
            input.listingId,
            input.amount,
            input.idempotencyKey,
            input.requestId ?? null,
            now,
            now,
          );
      } catch (err) {
        if (!isUniqueConstraintError(err)) {
          throw err;
        }
        // Restore hold — another writer won the idempotency key.
        this.setBalance(input.buyerId, current.toString(), now);
        const raced = this.findSpendByIdem(input.idempotencyKey);
        if (raced === undefined) {
          throw new StoreError("INTERNAL", "spend unique race vanished", 500);
        }
        if (raced.status === "settled") {
          return { kind: "already_settled", entry: raced };
        }
        return { kind: "in_flight", entry: raced };
      }

      const entry = this.findSpendByIdem(input.idempotencyKey);
      if (entry === undefined) {
        throw new StoreError("INTERNAL", "spend pending insert vanished", 500);
      }
      return { kind: "claimed", entry };
    });

    return claim();
  }

  /**
   * Finalize a pending spend after upstream completes.
   * settled → keep debit; failed → refund hold to buyer.
   */
  completeSpend(input: CompleteSpendInput): SpendLogEntry {
    const write = this.db.transaction(() => {
      const existing = this.findSpendByIdem(input.idempotencyKey);
      if (existing === undefined) {
        throw new StoreError(
          "VALIDATION",
          `unknown idempotency key: ${input.idempotencyKey}`,
          400,
        );
      }
      if (existing.status === "settled") {
        return existing;
      }

      const now = new Date().toISOString();

      if (input.status === "failed" && existing.status === "pending") {
        const bal = this.db
          .prepare(
            `SELECT buyer_id, balance, updated_at FROM buyer_balances WHERE buyer_id = ?`,
          )
          .get(existing.buyerId) as BalanceRow | undefined;
        const current = bal !== undefined ? BigInt(bal.balance) : 0n;
        const refunded = (current + BigInt(existing.amount)).toString();
        this.setBalance(existing.buyerId, refunded, now);
      }

      this.db
        .prepare(
          `UPDATE spend_log SET status = ?, upstream_status = ?, error_reason = ?, updated_at = ?
           WHERE idempotency_key = ?`,
        )
        .run(
          input.status,
          input.upstreamStatus ?? null,
          input.errorReason ?? null,
          now,
          input.idempotencyKey,
        );

      const refreshed = this.findSpendByIdem(input.idempotencyKey);
      if (refreshed === undefined) {
        throw new StoreError("INTERNAL", "spend update vanished", 500);
      }
      return refreshed;
    });

    return write();
  }

  listSpendLog(query: SpendLogQuery = {}): {
    entries: SpendLogEntry[];
    total: number;
  } {
    const q = SpendLogQuerySchema.parse(query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.buyerId !== undefined) {
      where.push("buyer_id = ?");
      params.push(q.buyerId);
    }
    if (q.listingId !== undefined) {
      where.push("listing_id = ?");
      params.push(q.listingId);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM spend_log ${whereSql}`)
      .get(...params) as { c: number };
    const rows = this.db
      .prepare(
        `SELECT * FROM spend_log ${whereSql}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, q.limit, q.offset) as SpendRow[];

    return {
      entries: rows.map(mapSpendRow),
      total: countRow.c,
    };
  }

  findSpendByIdem(key: string): SpendLogEntry | undefined {
    const row = this.db
      .prepare(`SELECT * FROM spend_log WHERE idempotency_key = ?`)
      .get(key) as SpendRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return mapSpendRow(row);
  }

  private setBalance(buyerId: string, balance: string, now: string): void {
    const existing = this.db
      .prepare(`SELECT buyer_id FROM buyer_balances WHERE buyer_id = ?`)
      .get(buyerId) as { buyer_id: string } | undefined;
    if (existing === undefined) {
      this.db
        .prepare(
          `INSERT INTO buyer_balances (buyer_id, balance, updated_at) VALUES (?, ?, ?)`,
        )
        .run(buyerId, balance, now);
    } else {
      this.db
        .prepare(
          `UPDATE buyer_balances SET balance = ?, updated_at = ? WHERE buyer_id = ?`,
        )
        .run(balance, now, buyerId);
    }
  }

  private reclaimFailed(
    existing: SpendLogEntry,
    input: BeginSpendInput,
  ): BeginSpendResult {
    const amount = BigInt(input.amount);
    const balRow = this.db
      .prepare(
        `SELECT buyer_id, balance, updated_at FROM buyer_balances WHERE buyer_id = ?`,
      )
      .get(input.buyerId) as BalanceRow | undefined;
    const current = balRow !== undefined ? BigInt(balRow.balance) : 0n;
    if (current < amount || balRow === undefined) {
      throw new StoreError(
        "INSUFFICIENT_BALANCE",
        `insufficient balance: have ${current.toString()}, need ${input.amount}`,
        402,
        {
          buyerId: input.buyerId,
          balance: current.toString(),
          required: input.amount,
        },
      );
    }
    const now = new Date().toISOString();
    this.setBalance(input.buyerId, (current - amount).toString(), now);

    const result = this.db
      .prepare(
        `UPDATE spend_log SET status = 'pending', buyer_id = ?, listing_id = ?,
         amount = ?, request_id = ?, upstream_status = NULL, error_reason = NULL,
         updated_at = ?
         WHERE idempotency_key = ? AND status IN ('failed', 'replayed')`,
      )
      .run(
        input.buyerId,
        input.listingId,
        input.amount,
        input.requestId ?? null,
        now,
        input.idempotencyKey,
      );

    if (result.changes === 0) {
      this.setBalance(input.buyerId, current.toString(), now);
      const again = this.findSpendByIdem(input.idempotencyKey);
      if (again === undefined) {
        throw new StoreError("INTERNAL", "spend reclaim vanished", 500);
      }
      if (again.status === "settled") {
        return { kind: "already_settled", entry: again };
      }
      return { kind: "in_flight", entry: again };
    }

    const refreshed = this.findSpendByIdem(input.idempotencyKey);
    if (refreshed === undefined) {
      throw new StoreError("INTERNAL", "spend reclaim refresh vanished", 500);
    }
    return { kind: "claimed", entry: refreshed };
  }
}

function mapSpendRow(row: SpendRow): SpendLogEntry {
  return SpendLogEntrySchema.parse({
    id: row.id,
    buyerId: row.buyer_id,
    listingId: row.listing_id,
    amount: row.amount,
    idempotencyKey: row.idempotency_key,
    requestId: row.request_id,
    status: row.status,
    upstreamStatus: row.upstream_status,
    errorReason: row.error_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function isUniqueConstraintError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT";
}
