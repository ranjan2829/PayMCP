import Database from "better-sqlite3";

/**
 * Open (or create) the store SQLite database.
 * Listings + buyer ledger share one file; settlement ledger stays in paymcp.
 */
export function openStoreDb(path: string = "./paymcp-store.db"): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}
