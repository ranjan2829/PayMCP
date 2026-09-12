import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { StoreError } from "../errors/index.js";
import {
  CreateListingInputSchema,
  ListingSchema,
  UpdateListingInputSchema,
  type CatalogQuery,
  type CreateListingInput,
  type Listing,
  type ListingStatus,
  type UpdateListingInput,
  CatalogQuerySchema,
} from "./schemas.js";

interface ListingRow {
  id: string;
  name: string;
  description: string;
  openapi_url: string | null;
  openapi_json: string | null;
  price: string;
  seller_id: string;
  pay_to: string;
  network: string;
  status: string;
  upstream_base_url: string | null;
  default_path: string;
  default_method: string;
  external_x402: number;
  tags_json: string;
  created_at: string;
  updated_at: string;
}

/**
 * SQLite-backed CRUD registry for tool listings.
 * Isolated from the settlement ledger (paymcp SqliteLedger) — store listings
 * and buyer balances live in the store DB.
 */
export class ListingRegistry {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        openapi_url TEXT,
        openapi_json TEXT,
        price TEXT NOT NULL,
        seller_id TEXT NOT NULL,
        pay_to TEXT NOT NULL,
        network TEXT NOT NULL,
        status TEXT NOT NULL,
        upstream_base_url TEXT,
        default_path TEXT NOT NULL DEFAULT '/',
        default_method TEXT NOT NULL DEFAULT 'POST',
        external_x402 INTEGER NOT NULL DEFAULT 0,
        tags_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
      CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller_id);
    `);
  }

  create(input: CreateListingInput): Listing {
    const parsed = CreateListingInputSchema.parse(input);
    const id = parsed.id ?? `lst_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const existing = this.findById(id);
    if (existing !== undefined) {
      throw new StoreError(
        "LISTING_INVALID",
        `listing id already exists: ${id}`,
        409,
        { id },
      );
    }

    const now = new Date().toISOString();
    const openapiJson =
      parsed.openapi !== undefined ? JSON.stringify(parsed.openapi) : null;

    this.db
      .prepare(
        `INSERT INTO listings (
          id, name, description, openapi_url, openapi_json, price, seller_id,
          pay_to, network, status, upstream_base_url, default_path, default_method,
          external_x402, tags_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        parsed.name,
        parsed.description,
        parsed.openapiUrl ?? null,
        openapiJson,
        parsed.price,
        parsed.sellerId,
        parsed.payTo,
        parsed.network,
        parsed.status,
        parsed.upstreamBaseUrl ?? null,
        parsed.defaultPath,
        parsed.defaultMethod,
        parsed.externalX402 ? 1 : 0,
        JSON.stringify(parsed.tags),
        now,
        now,
      );

    const created = this.findById(id);
    if (created === undefined) {
      throw new StoreError("INTERNAL", "listing insert vanished", 500);
    }
    return created;
  }

  findById(id: string): Listing | undefined {
    const row = this.db
      .prepare(`SELECT * FROM listings WHERE id = ?`)
      .get(id) as ListingRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return mapListingRow(row);
  }

  getOrThrow(id: string): Listing {
    const listing = this.findById(id);
    if (listing === undefined) {
      throw new StoreError("LISTING_NOT_FOUND", `listing not found: ${id}`, 404, {
        id,
      });
    }
    return listing;
  }

  update(id: string, input: UpdateListingInput): Listing {
    const parsed = UpdateListingInputSchema.parse(input);
    const current = this.getOrThrow(id);
    const now = new Date().toISOString();

    const name = parsed.name ?? current.name;
    const description = parsed.description ?? current.description;
    const openapiUrl =
      parsed.openapiUrl !== undefined
        ? parsed.openapiUrl
        : current.openapiUrl;
    const openapiJson =
      parsed.openapi !== undefined
        ? JSON.stringify(parsed.openapi)
        : current.openapiJson;
    const price = parsed.price ?? current.price;
    const payTo = parsed.payTo ?? current.payTo;
    const network = parsed.network ?? current.network;
    const status = parsed.status ?? current.status;
    const upstreamBaseUrl =
      parsed.upstreamBaseUrl !== undefined
        ? parsed.upstreamBaseUrl
        : current.upstreamBaseUrl;
    const defaultPath = parsed.defaultPath ?? current.defaultPath;
    const defaultMethod = parsed.defaultMethod ?? current.defaultMethod;
    const externalX402 =
      parsed.externalX402 !== undefined
        ? parsed.externalX402
        : current.externalX402;
    const tags = parsed.tags ?? current.tags;

    this.db
      .prepare(
        `UPDATE listings SET
          name = ?, description = ?, openapi_url = ?, openapi_json = ?,
          price = ?, pay_to = ?, network = ?, status = ?,
          upstream_base_url = ?, default_path = ?, default_method = ?,
          external_x402 = ?, tags_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        name,
        description,
        openapiUrl,
        openapiJson,
        price,
        payTo,
        network,
        status,
        upstreamBaseUrl,
        defaultPath,
        defaultMethod,
        externalX402 ? 1 : 0,
        JSON.stringify(tags),
        now,
        id,
      );

    return this.getOrThrow(id);
  }

  setStatus(id: string, status: ListingStatus): Listing {
    return this.update(id, { status });
  }

  delete(id: string): void {
    const result = this.db.prepare(`DELETE FROM listings WHERE id = ?`).run(id);
    if (result.changes === 0) {
      throw new StoreError("LISTING_NOT_FOUND", `listing not found: ${id}`, 404, {
        id,
      });
    }
  }

  list(query: CatalogQuery = {}): { listings: Listing[]; total: number } {
    const q = CatalogQuerySchema.parse(query);
    const where: string[] = [];
    const params: unknown[] = [];

    if (q.status !== undefined) {
      where.push("status = ?");
      params.push(q.status);
    }
    if (q.sellerId !== undefined) {
      where.push("seller_id = ?");
      params.push(q.sellerId);
    }
    if (q.tag !== undefined) {
      where.push("tags_json LIKE ?");
      params.push(`%"${q.tag}"%`);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM listings ${whereSql}`)
      .get(...params) as { c: number };
    const rows = this.db
      .prepare(
        `SELECT * FROM listings ${whereSql}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, q.limit, q.offset) as ListingRow[];

    return {
      listings: rows.map(mapListingRow),
      total: countRow.c,
    };
  }
}

function mapListingRow(row: ListingRow): Listing {
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.tags_json);
    if (Array.isArray(parsed)) {
      tags = parsed.filter((t): t is string => typeof t === "string");
    }
  } catch {
    tags = [];
  }

  const candidate = {
    id: row.id,
    name: row.name,
    description: row.description,
    openapiUrl: row.openapi_url,
    openapiJson: row.openapi_json,
    price: row.price,
    sellerId: row.seller_id,
    payTo: row.pay_to,
    network: row.network,
    status: row.status,
    upstreamBaseUrl: row.upstream_base_url,
    defaultPath: row.default_path,
    defaultMethod: row.default_method,
    externalX402: row.external_x402 === 1,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  return ListingSchema.parse(candidate);
}
