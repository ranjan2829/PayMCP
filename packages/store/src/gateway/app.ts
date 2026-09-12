import Fastify, { type FastifyInstance } from "fastify";
import {
  createSettlementWebhookSender,
  type PaymcpEnvConfig,
} from "openapi-to-paymcp";
import type { StoreEnvConfig } from "../config/env.js";
import { openStoreDb } from "../db.js";
import { ListingRegistry } from "../listings/registry.js";
import { BuyerBalanceLedger } from "../ledger/balance.js";
import { InvokeGateway } from "./invoke.js";
import { registerStoreRoutes } from "./routes.js";

export interface CreateStoreAppOptions {
  readonly env: StoreEnvConfig;
  /** Override DB path (tests use :memory: via file path or temp). */
  readonly dbPath?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface StoreApp {
  readonly app: FastifyInstance;
  readonly listings: ListingRegistry;
  readonly ledger: BuyerBalanceLedger;
  readonly invoke: InvokeGateway;
  readonly close: () => Promise<void>;
}

/**
 * Build the Fastify store server with listings, ledger, and invoke gateway.
 */
export async function createStoreApp(
  options: CreateStoreAppOptions,
): Promise<StoreApp> {
  const dbPath = options.dbPath ?? options.env.STORE_DB_PATH;
  const db = openStoreDb(dbPath);
  const listings = new ListingRegistry(db);
  const ledger = new BuyerBalanceLedger(db);

  let webhook = undefined;
  if (options.env.PAYMCP_WEBHOOK_URL !== undefined) {
    const secret = options.env.PAYMCP_WEBHOOK_SECRET;
    if (secret === undefined) {
      throw new Error(
        "PAYMCP_WEBHOOK_SECRET is required when PAYMCP_WEBHOOK_URL is set",
      );
    }
    const paymcpCfg: PaymcpEnvConfig = {
      facilitatorUrl: "https://x402.org/facilitator",
      payTo: options.env.STORE_SEED_PAY_TO,
      network: options.env.STORE_SEED_NETWORK,
      asset: "0x0000000000000000000000000000000000000000",
      webhookUrl: options.env.PAYMCP_WEBHOOK_URL,
      webhookSecret: secret,
      ...(options.env.PAYMCP_WEBHOOK_TIMEOUT_MS !== undefined
        ? { webhookTimeoutMs: options.env.PAYMCP_WEBHOOK_TIMEOUT_MS }
        : {}),
      ...(options.env.PAYMCP_WEBHOOK_MAX_RETRIES !== undefined
        ? { webhookMaxRetries: options.env.PAYMCP_WEBHOOK_MAX_RETRIES }
        : {}),
    };
    webhook = createSettlementWebhookSender(paymcpCfg);
  }

  const invoke = new InvokeGateway({
    listings,
    ledger,
    ...(webhook !== undefined ? { webhook } : {}),
    ...(options.fetchImpl !== undefined
      ? { fetchImpl: options.fetchImpl }
      : {}),
    asset: "USDC",
  });

  const app = Fastify({
    logger: { level: options.env.LOG_LEVEL },
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  });

  await registerStoreRoutes(app, { listings, ledger, invoke });

  return {
    app,
    listings,
    ledger,
    invoke,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}
