import type { PaymcpEnvConfig } from "../types/config.js";
import type { Ledger } from "./types.js";
import { SqliteLedger } from "./sqlite.js";

/**
 * Create a ledger from config.
 * Uses Postgres when PAYMCP_DATABASE_URL / config.databaseUrl is set; else SQLite.
 */
export async function createLedger(
  config: Pick<PaymcpEnvConfig, "databaseUrl" | "ledgerPath">,
): Promise<Ledger> {
  if (config.databaseUrl !== undefined && config.databaseUrl.length > 0) {
    const { PostgresLedger } = await import("./postgres.js");
    const ledger = new PostgresLedger(config.databaseUrl);
    await ledger.migrate();
    return ledger;
  }
  return new SqliteLedger(config.ledgerPath ?? "./paymcp-ledger.db");
}
