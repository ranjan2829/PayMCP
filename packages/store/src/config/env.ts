import { z } from "zod";

const EvmAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 40-hex EVM address");

const EvmPrivateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x-prefixed 64-hex private key");

const StoreEnvSchema = z.object({
  STORE_HOST: z.string().default("127.0.0.1"),
  STORE_PORT: z.coerce.number().int().min(1).max(65535).default(8790),
  STORE_DB_PATH: z.string().default("./paymcp-store.db"),
  STORE_PUBLIC_BASE_URL: z.string().url().optional(),
  /** Optional settlement webhook (reuse paymcp shape). */
  PAYMCP_WEBHOOK_URL: z.string().url().optional(),
  PAYMCP_WEBHOOK_SECRET: z.string().min(16).optional(),
  PAYMCP_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  PAYMCP_WEBHOOK_MAX_RETRIES: z.coerce.number().int().min(0).max(10).optional(),
  /** Default network for seeded listings. */
  STORE_SEED_NETWORK: z.string().default("eip155:84532"),
  /**
   * Required seller payTo for seed listings — no zero-address default.
   * Seed / serve auto-seed fail closed when unset.
   */
  STORE_SEED_PAY_TO: EvmAddress.optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  /** Stripe fiat → credits (required to enable funding routes). */
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_SUCCESS_URL: z.string().url().optional(),
  STRIPE_CANCEL_URL: z.string().url().optional(),

  /** Seller payout (USDC transfer to listing.payTo). */
  STORE_OPERATOR_PRIVATE_KEY: EvmPrivateKey.optional(),
  STORE_RPC_URL: z.string().url().optional(),
  PAYMCP_ASSET: EvmAddress.optional(),
  PAYMCP_FACILITATOR_URL: z.string().url().optional(),
  PAYMCP_FACILITATOR_AUTH_TOKEN: z.string().min(1).optional(),
  PAYMCP_ASSET_NAME: z.string().min(1).optional(),
  PAYMCP_NETWORK: z.string().optional(),

  /**
   * When "1" (default for serve), require payout executor env
   * (STORE_OPERATOR_PRIVATE_KEY + STORE_RPC_URL + PAYMCP_ASSET).
   */
  STORE_REQUIRE_PAYOUT: z.enum(["0", "1"]).optional(),
});

export type StoreEnvConfig = z.infer<typeof StoreEnvSchema>;

export function loadStoreEnv(
  env: NodeJS.ProcessEnv = process.env,
): StoreEnvConfig {
  const parsed = StoreEnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new Error(`Invalid store env:\n${lines.join("\n")}`);
  }
  const cfg = parsed.data;
  if (cfg.PAYMCP_WEBHOOK_URL !== undefined && cfg.PAYMCP_WEBHOOK_SECRET === undefined) {
    throw new Error(
      "PAYMCP_WEBHOOK_SECRET is required when PAYMCP_WEBHOOK_URL is set",
    );
  }
  const stripeAny =
    cfg.STRIPE_SECRET_KEY !== undefined || cfg.STRIPE_WEBHOOK_SECRET !== undefined;
  if (stripeAny) {
    if (cfg.STRIPE_SECRET_KEY === undefined || cfg.STRIPE_WEBHOOK_SECRET === undefined) {
      throw new Error(
        "STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are both required when Stripe funding is enabled",
      );
    }
  }
  return cfg;
}

/** Fail closed when seed needs a real payTo. */
export function requireSeedPayTo(env: StoreEnvConfig): string {
  if (env.STORE_SEED_PAY_TO === undefined) {
    throw new Error(
      "STORE_SEED_PAY_TO is required (0x-prefixed EVM address). " +
        "No zero-address default — set it in the environment before seed/serve.",
    );
  }
  return env.STORE_SEED_PAY_TO;
}

export function isStripeFundingEnabled(env: StoreEnvConfig): boolean {
  return (
    env.STRIPE_SECRET_KEY !== undefined && env.STRIPE_WEBHOOK_SECRET !== undefined
  );
}

export function isUsdcPayoutConfigured(env: StoreEnvConfig): boolean {
  return (
    env.STORE_OPERATOR_PRIVATE_KEY !== undefined &&
    env.STORE_RPC_URL !== undefined &&
    env.PAYMCP_ASSET !== undefined
  );
}
