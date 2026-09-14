import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  createSettlementWebhookSender,
  type PaymcpEnvConfig,
} from "openapi-to-paymcp";
import {
  isStripeFundingEnabled,
  isUsdcPayoutConfigured,
  type StoreEnvConfig,
} from "../config/env.js";
import { openStoreDb } from "../db.js";
import { ListingRegistry } from "../listings/registry.js";
import { BuyerBalanceLedger } from "../ledger/balance.js";
import { StripeFundingClient } from "../funding/stripe.js";
import {
  SellerPayoutQueue,
  SellerPayoutService,
  UsdcTransferPayout,
  type SellerPayoutExecutor,
} from "../payout/index.js";
import { InvokeGateway } from "./invoke.js";
import { registerStoreRoutes } from "./routes.js";
import { ReceiptService } from "../receipts/service.js";

export interface CreateStoreAppOptions {
  readonly env: StoreEnvConfig;
  /** Override DB path (tests use :memory: via file path or temp). */
  readonly dbPath?: string;
  readonly fetchImpl?: typeof fetch;
  /** Inject payout executor (tests). When omitted, built from env. */
  readonly payoutExecutor?: SellerPayoutExecutor;
  /**
   * When true (default), serve paths that require payout must have executor
   * env or an injected executor. Tests pass RecordingPayoutExecutor.
   */
  readonly requirePayout?: boolean;
}

export interface StoreApp {
  readonly app: FastifyInstance;
  readonly listings: ListingRegistry;
  readonly ledger: BuyerBalanceLedger;
  readonly invoke: InvokeGateway;
  readonly payouts: SellerPayoutService;
  readonly close: () => Promise<void>;
}

/**
 * Build the Fastify store server with listings, ledger, funding, invoke, payouts.
 */
export async function createStoreApp(
  options: CreateStoreAppOptions,
): Promise<StoreApp> {
  const dbPath = options.dbPath ?? options.env.STORE_DB_PATH;
  const db = openStoreDb(dbPath);
  const listings = new ListingRegistry(db);
  const ledger = new BuyerBalanceLedger(db);
  const payoutQueue = new SellerPayoutQueue(db);

  const requirePayout =
    options.requirePayout ??
    (options.env.STORE_REQUIRE_PAYOUT !== "0");

  let executor: SellerPayoutExecutor;
  if (options.payoutExecutor !== undefined) {
    executor = options.payoutExecutor;
  } else if (isUsdcPayoutConfigured(options.env)) {
    executor = new UsdcTransferPayout({
      privateKey: options.env.STORE_OPERATOR_PRIVATE_KEY as `0x${string}`,
      rpcUrl: options.env.STORE_RPC_URL!,
      asset: options.env.PAYMCP_ASSET as `0x${string}`,
    });
  } else if (requirePayout) {
    throw new Error(
      "Seller payout requires STORE_OPERATOR_PRIVATE_KEY, STORE_RPC_URL, and PAYMCP_ASSET " +
        "(USDC transfer to listing.payTo), or inject payoutExecutor. " +
        "Set STORE_REQUIRE_PAYOUT=0 only for local read-only experiments — product invoke needs payout.",
    );
  } else {
    // Deferred: enqueue only; flush will fail until configured.
    executor = {
      async execute() {
        throw new Error(
          "payout executor not configured — set STORE_OPERATOR_PRIVATE_KEY, STORE_RPC_URL, PAYMCP_ASSET",
        );
      },
    };
  }

  const defaultAsset = options.env.PAYMCP_ASSET ?? "";
  const payouts = new SellerPayoutService({
    queue: payoutQueue,
    executor,
    defaultAsset,
  });

  let webhook = undefined;
  if (options.env.PAYMCP_WEBHOOK_URL !== undefined) {
    const secret = options.env.PAYMCP_WEBHOOK_SECRET;
    if (secret === undefined) {
      throw new Error(
        "PAYMCP_WEBHOOK_SECRET is required when PAYMCP_WEBHOOK_URL is set",
      );
    }
    // Webhook sender needs payTo/asset for PaymcpEnvConfig shape;
    // listing.payTo is what sellers receive on settle.
    if (options.env.STORE_SEED_PAY_TO === undefined) {
      throw new Error(
        "STORE_SEED_PAY_TO is required when PAYMCP_WEBHOOK_URL is set",
      );
    }
    if (options.env.PAYMCP_ASSET === undefined) {
      throw new Error(
        "PAYMCP_ASSET is required when PAYMCP_WEBHOOK_URL is set",
      );
    }
    const payTo = options.env.STORE_SEED_PAY_TO;
    const asset = options.env.PAYMCP_ASSET;
    const paymcpCfg: PaymcpEnvConfig = {
      facilitatorUrl:
        options.env.PAYMCP_FACILITATOR_URL ?? "https://x402.org/facilitator",
      payTo,
      network: options.env.STORE_SEED_NETWORK,
      asset,
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
    payouts,
    ...(webhook !== undefined ? { webhook } : {}),
    ...(options.fetchImpl !== undefined
      ? { fetchImpl: options.fetchImpl }
      : {}),
    asset: options.env.PAYMCP_ASSET_NAME ?? "USDC",
  });

  const stripe = isStripeFundingEnabled(options.env)
    ? new StripeFundingClient({
        secretKey: options.env.STRIPE_SECRET_KEY!,
        webhookSecret: options.env.STRIPE_WEBHOOK_SECRET!,
        ...(options.fetchImpl !== undefined
          ? { fetchImpl: options.fetchImpl }
          : {}),
      })
    : undefined;

  const app = Fastify({
    logger: { level: options.env.LOG_LEVEL },
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  });

  // Preserve raw body for Stripe webhook HMAC verification.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
      (req as FastifyRequest & { rawBody?: string }).rawBody = buf.toString("utf8");
      try {
        const text = buf.toString("utf8");
        const json = text.length > 0 ? JSON.parse(text) : {};
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  const receipts = new ReceiptService({
    listings,
    ledger,
    payouts: payoutQueue,
    ...(options.env.STORE_PUBLIC_BASE_URL !== undefined
      ? { publicBaseUrl: options.env.STORE_PUBLIC_BASE_URL }
      : {}),
    assetLabel: options.env.PAYMCP_ASSET_NAME ?? "USDC",
  });

  await registerStoreRoutes(app, {
    listings,
    ledger,
    invoke,
    ...(stripe !== undefined ? { stripe } : {}),
    payouts,
    receipts,
    ...(options.env.STORE_PUBLIC_BASE_URL !== undefined
      ? { publicBaseUrl: options.env.STORE_PUBLIC_BASE_URL }
      : {}),
    ...(options.env.STRIPE_SUCCESS_URL !== undefined
      ? { stripeSuccessUrl: options.env.STRIPE_SUCCESS_URL }
      : {}),
    ...(options.env.STRIPE_CANCEL_URL !== undefined
      ? { stripeCancelUrl: options.env.STRIPE_CANCEL_URL }
      : {}),
  });

  return {
    app,
    listings,
    ledger,
    invoke,
    payouts,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}
