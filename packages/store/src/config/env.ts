import { z } from "zod";

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
  /** Default network / payTo for seeded listings. */
  STORE_SEED_NETWORK: z.string().default("eip155:84532"),
  STORE_SEED_PAY_TO: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .default("0x0000000000000000000000000000000000000001"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
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
  return cfg;
}
