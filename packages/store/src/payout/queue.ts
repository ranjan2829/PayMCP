import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { StoreError } from "../errors/index.js";

export type PayoutStatus = "pending" | "paid" | "failed";

export interface SellerPayout {
  readonly id: string;
  readonly spendId: string;
  readonly listingId: string;
  readonly sellerId: string;
  readonly payTo: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly status: PayoutStatus;
  readonly transaction: string | null;
  readonly errorReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EnqueuePayoutInput {
  readonly spendId: string;
  readonly listingId: string;
  readonly sellerId: string;
  readonly payTo: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
}

interface PayoutRow {
  id: string;
  spend_id: string;
  listing_id: string;
  seller_id: string;
  pay_to: string;
  network: string;
  asset: string;
  amount: string;
  status: string;
  tx_hash: string | null;
  error_reason: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Durable seller payout obligations — one row per settled spend.
 * Credit debit without a payout row is incomplete; InvokeGateway enqueues on 2xx.
 */
export class SellerPayoutQueue {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seller_payouts (
        id TEXT PRIMARY KEY,
        spend_id TEXT NOT NULL UNIQUE,
        listing_id TEXT NOT NULL,
        seller_id TEXT NOT NULL,
        pay_to TEXT NOT NULL,
        network TEXT NOT NULL,
        asset TEXT NOT NULL,
        amount TEXT NOT NULL,
        status TEXT NOT NULL,
        tx_hash TEXT,
        error_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_payout_status ON seller_payouts(status);
      CREATE INDEX IF NOT EXISTS idx_payout_pay_to ON seller_payouts(pay_to);
    `);
  }

  /** Idempotent on spendId — returns existing row if already enqueued. */
  enqueue(input: EnqueuePayoutInput): SellerPayout {
    const existing = this.findBySpendId(input.spendId);
    if (existing !== undefined) {
      return existing;
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO seller_payouts (
            id, spend_id, listing_id, seller_id, pay_to, network, asset, amount,
            status, tx_hash, error_reason, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
        )
        .run(
          id,
          input.spendId,
          input.listingId,
          input.sellerId,
          input.payTo,
          input.network,
          input.asset,
          input.amount,
          now,
          now,
        );
    } catch (err) {
      const raced = this.findBySpendId(input.spendId);
      if (raced !== undefined) {
        return raced;
      }
      throw err;
    }
    const row = this.findBySpendId(input.spendId);
    if (row === undefined) {
      throw new StoreError("INTERNAL", "payout enqueue vanished", 500);
    }
    return row;
  }

  markPaid(id: string, transaction: string): SellerPayout {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE seller_payouts SET status = 'paid', tx_hash = ?, error_reason = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(transaction, now, id);
    const row = this.getOrThrow(id);
    return row;
  }

  markFailed(id: string, errorReason: string): SellerPayout {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE seller_payouts SET status = 'failed', error_reason = ?, updated_at = ?
         WHERE id = ? AND status != 'paid'`,
      )
      .run(errorReason, now, id);
    return this.getOrThrow(id);
  }

  /** Re-open a failed payout for retry. */
  requeue(id: string): SellerPayout {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE seller_payouts SET status = 'pending', error_reason = NULL, updated_at = ?
         WHERE id = ? AND status = 'failed'`,
      )
      .run(now, id);
    return this.getOrThrow(id);
  }

  listPending(limit = 50): SellerPayout[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM seller_payouts WHERE status IN ('pending', 'failed')
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(limit) as PayoutRow[];
    return rows.map(mapRow);
  }

  findBySpendId(spendId: string): SellerPayout | undefined {
    const row = this.db
      .prepare(`SELECT * FROM seller_payouts WHERE spend_id = ?`)
      .get(spendId) as PayoutRow | undefined;
    return row === undefined ? undefined : mapRow(row);
  }

  getOrThrow(id: string): SellerPayout {
    const row = this.db
      .prepare(`SELECT * FROM seller_payouts WHERE id = ?`)
      .get(id) as PayoutRow | undefined;
    if (row === undefined) {
      throw new StoreError("VALIDATION", `unknown payout: ${id}`, 404);
    }
    return mapRow(row);
  }
}

function mapRow(row: PayoutRow): SellerPayout {
  return {
    id: row.id,
    spendId: row.spend_id,
    listingId: row.listing_id,
    sellerId: row.seller_id,
    payTo: row.pay_to,
    network: row.network,
    asset: row.asset,
    amount: row.amount,
    status: row.status as PayoutStatus,
    transaction: row.tx_hash,
    errorReason: row.error_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
