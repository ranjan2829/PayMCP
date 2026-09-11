import { z } from "zod";
import type { Caip2Network, PaymentScheme } from "./x402.js";

/** Required environment / runtime config for real facilitator settlement. */
export interface PaymcpEnvConfig {
  /** Facilitator base URL, e.g. https://api.cdp.coinbase.com/platform/v2/x402 or https://x402.org/facilitator */
  readonly facilitatorUrl: string;
  /** Recipient address (payTo) for settled payments. */
  readonly payTo: string;
  /** CAIP-2 network, e.g. eip155:84532 */
  readonly network: Caip2Network;
  /** Asset contract / mint address (e.g. USDC on the chosen network). */
  readonly asset: string;
  /** Optional Bearer / JWT for facilitators that require auth (CDP). */
  readonly facilitatorAuthToken?: string;
  /** Optional CDP API key id (documented for operators; token may be pre-minted). */
  readonly cdpApiKeyId?: string;
  /** Optional asset display metadata. */
  readonly assetName?: string;
  /** Default maxTimeoutSeconds for PaymentRequired accepts. */
  readonly maxTimeoutSeconds?: number;
  /** Payment scheme (default exact). */
  readonly scheme?: PaymentScheme;
  /** SQLite ledger path (default ./paymcp-ledger.db). Ignored when databaseUrl is set. */
  readonly ledgerPath?: string;
  /** Optional Postgres connection URL. When set, ledger uses Postgres instead of SQLite. */
  readonly databaseUrl?: string;
  /** Facilitator HTTP timeout in ms (default 15_000). */
  readonly facilitatorTimeoutMs?: number;
  /** Max retries on 5xx/network only (default 2). Invalid payments are never retried. */
  readonly facilitatorMaxRetries?: number;
  /** Optional simple rate limit: max paid requests per window per IP (0 = off). */
  readonly rateLimitMax?: number;
  /** Rate limit window in ms (default 60_000). */
  readonly rateLimitWindowMs?: number;
  /**
   * Comma-separated operationId allowlist (from PAYMCP_ALLOWLIST).
   * When set, only listed ops may be paid/exposed; others get 403.
   */
  readonly allowlist?: string;
  /** Default max settled spend per tool per day (atomic units decimal string). */
  readonly defaultMaxDailyAtomic?: string;
  /** Budget window: calendar_day_utc (default) or rolling_24h. */
  readonly budgetWindow?: "calendar_day_utc" | "rolling_24h";
  /** Optional path to budgets.yaml (also loadable via PAYMCP_BUDGETS_PATH). */
  readonly budgetsPath?: string;
}

export interface OperationPrice {
  readonly operationId: string;
  /** Atomic units as decimal string (e.g. USDC 6 decimals: "10000" = $0.01). */
  readonly amount: string;
  readonly description?: string;
  /** If false, route is free (no 402). Default true when listed. */
  readonly paid?: boolean;
  /** Optional per-tool daily spend cap in atomic units (decimal string). */
  readonly maxDailyAtomic?: string;
}

export interface PricesFile {
  readonly version: 1;
  /** When non-empty, only these operationIds may be paid/exposed. */
  readonly allowlist?: readonly string[];
  readonly operations: readonly OperationPrice[];
}

export interface XPaymcpExtension {
  readonly amount: string;
  readonly description?: string;
  readonly paid?: boolean;
}

export const ENV_KEYS = {
  facilitatorUrl: "PAYMCP_FACILITATOR_URL",
  payTo: "PAYMCP_PAY_TO",
  network: "PAYMCP_NETWORK",
  asset: "PAYMCP_ASSET",
  facilitatorAuthToken: "PAYMCP_FACILITATOR_AUTH_TOKEN",
  cdpApiKeyId: "CDP_API_KEY_ID",
  cdpApiKeySecret: "CDP_API_KEY_SECRET",
  assetName: "PAYMCP_ASSET_NAME",
  maxTimeoutSeconds: "PAYMCP_MAX_TIMEOUT_SECONDS",
  scheme: "PAYMCP_SCHEME",
  ledgerPath: "PAYMCP_LEDGER_PATH",
  databaseUrl: "PAYMCP_DATABASE_URL",
  facilitatorTimeoutMs: "PAYMCP_FACILITATOR_TIMEOUT_MS",
  facilitatorMaxRetries: "PAYMCP_FACILITATOR_MAX_RETRIES",
  rateLimitMax: "PAYMCP_RATE_LIMIT_MAX",
  rateLimitWindowMs: "PAYMCP_RATE_LIMIT_WINDOW_MS",
  allowlist: "PAYMCP_ALLOWLIST",
  defaultMaxDailyAtomic: "PAYMCP_DEFAULT_MAX_DAILY_ATOMIC",
  budgetWindow: "PAYMCP_BUDGET_WINDOW",
  budgetsPath: "PAYMCP_BUDGETS_PATH",
} as const;

const nonEmpty = z.string().trim().min(1);

const paymcpEnvZod = z
  .object({
    facilitatorUrl: nonEmpty
      .url({ message: `${ENV_KEYS.facilitatorUrl} must be a valid URL` })
      .refine(
        (u) => u.startsWith("http://") || u.startsWith("https://"),
        `${ENV_KEYS.facilitatorUrl} must be http(s)`,
      ),
    payTo: nonEmpty.refine(
      (v) => /^0x[a-fA-F0-9]{40}$/.test(v) || v.length >= 4,
      `${ENV_KEYS.payTo} must be a recipient address (0x… for EVM)`,
    ),
    network: nonEmpty.regex(
      /^[a-z0-9]+:.+$/i,
      `${ENV_KEYS.network} must be CAIP-2 (e.g. eip155:84532)`,
    ),
    asset: nonEmpty,
    facilitatorAuthToken: nonEmpty.optional(),
    cdpApiKeyId: nonEmpty.optional(),
    assetName: nonEmpty.optional(),
    maxTimeoutSeconds: z.number().int().positive().optional(),
    scheme: z.enum(["exact", "upto"]).optional(),
    ledgerPath: nonEmpty.optional(),
    databaseUrl: nonEmpty
      .refine(
        (u) => u.startsWith("postgres://") || u.startsWith("postgresql://"),
        `${ENV_KEYS.databaseUrl} must be a postgres(ql):// URL`,
      )
      .optional(),
    facilitatorTimeoutMs: z.number().int().positive().max(120_000).optional(),
    facilitatorMaxRetries: z.number().int().min(0).max(5).optional(),
    rateLimitMax: z.number().int().min(0).optional(),
    rateLimitWindowMs: z.number().int().positive().optional(),
    allowlist: nonEmpty.optional(),
    defaultMaxDailyAtomic: z
      .string()
      .regex(/^\d+$/, `${ENV_KEYS.defaultMaxDailyAtomic} must be a decimal integer string`)
      .optional(),
    budgetWindow: z.enum(["calendar_day_utc", "rolling_24h"]).optional(),
    budgetsPath: nonEmpty.optional(),
  })
  .strict();

export type PaymcpEnvZod = z.infer<typeof paymcpEnvZod>;

export class ConfigValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `PayMCP config invalid — fix env before starting the server:\n` +
        issues.map((i) => `  • ${i}`).join("\n"),
    );
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

/**
 * Fail-fast env loader. Throws ConfigValidationError with clear messages when
 * facilitatorUrl / payTo / network / asset are missing or malformed.
 */
export function loadConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PaymcpEnvConfig {
  const raw = {
    facilitatorUrl: optionalEnv(env, ENV_KEYS.facilitatorUrl),
    payTo: optionalEnv(env, ENV_KEYS.payTo),
    network: optionalEnv(env, ENV_KEYS.network),
    asset: optionalEnv(env, ENV_KEYS.asset),
    facilitatorAuthToken: optionalEnv(env, ENV_KEYS.facilitatorAuthToken),
    cdpApiKeyId: optionalEnv(env, ENV_KEYS.cdpApiKeyId),
    assetName: optionalEnv(env, ENV_KEYS.assetName),
    maxTimeoutSeconds: parsePositiveInt(
      optionalEnv(env, ENV_KEYS.maxTimeoutSeconds),
      ENV_KEYS.maxTimeoutSeconds,
    ),
    scheme: optionalEnv(env, ENV_KEYS.scheme),
    ledgerPath: optionalEnv(env, ENV_KEYS.ledgerPath),
    databaseUrl: optionalEnv(env, ENV_KEYS.databaseUrl),
    facilitatorTimeoutMs: parsePositiveInt(
      optionalEnv(env, ENV_KEYS.facilitatorTimeoutMs),
      ENV_KEYS.facilitatorTimeoutMs,
    ),
    facilitatorMaxRetries: parseNonNegInt(
      optionalEnv(env, ENV_KEYS.facilitatorMaxRetries),
      ENV_KEYS.facilitatorMaxRetries,
    ),
    rateLimitMax: parseNonNegInt(
      optionalEnv(env, ENV_KEYS.rateLimitMax),
      ENV_KEYS.rateLimitMax,
    ),
    rateLimitWindowMs: parsePositiveInt(
      optionalEnv(env, ENV_KEYS.rateLimitWindowMs),
      ENV_KEYS.rateLimitWindowMs,
    ),
    allowlist: optionalEnv(env, ENV_KEYS.allowlist),
    defaultMaxDailyAtomic: optionalEnv(env, ENV_KEYS.defaultMaxDailyAtomic),
    budgetWindow: optionalEnv(env, ENV_KEYS.budgetWindow),
    budgetsPath: optionalEnv(env, ENV_KEYS.budgetsPath),
  };

  const missing: string[] = [];
  if (raw.facilitatorUrl === undefined) {
    missing.push(
      `${ENV_KEYS.facilitatorUrl} is required (e.g. https://x402.org/facilitator)`,
    );
  }
  if (raw.payTo === undefined) {
    missing.push(
      `${ENV_KEYS.payTo} is required (recipient address that receives USDC)`,
    );
  }
  if (raw.network === undefined) {
    missing.push(
      `${ENV_KEYS.network} is required (CAIP-2, e.g. eip155:84532 for Base Sepolia)`,
    );
  }
  if (raw.asset === undefined) {
    missing.push(
      `${ENV_KEYS.asset} is required (USDC contract on that network)`,
    );
  }
  if (missing.length > 0) {
    throw new ConfigValidationError(missing);
  }

  const parsed = paymcpEnvZod.safeParse({
    facilitatorUrl: raw.facilitatorUrl,
    payTo: raw.payTo,
    network: raw.network,
    asset: raw.asset,
    ...(raw.facilitatorAuthToken !== undefined
      ? { facilitatorAuthToken: raw.facilitatorAuthToken }
      : {}),
    ...(raw.cdpApiKeyId !== undefined ? { cdpApiKeyId: raw.cdpApiKeyId } : {}),
    ...(raw.assetName !== undefined ? { assetName: raw.assetName } : {}),
    ...(raw.maxTimeoutSeconds !== undefined
      ? { maxTimeoutSeconds: raw.maxTimeoutSeconds }
      : {}),
    ...(raw.scheme !== undefined ? { scheme: raw.scheme } : {}),
    ...(raw.ledgerPath !== undefined ? { ledgerPath: raw.ledgerPath } : {}),
    ...(raw.databaseUrl !== undefined ? { databaseUrl: raw.databaseUrl } : {}),
    ...(raw.facilitatorTimeoutMs !== undefined
      ? { facilitatorTimeoutMs: raw.facilitatorTimeoutMs }
      : {}),
    ...(raw.facilitatorMaxRetries !== undefined
      ? { facilitatorMaxRetries: raw.facilitatorMaxRetries }
      : {}),
    ...(raw.rateLimitMax !== undefined
      ? { rateLimitMax: raw.rateLimitMax }
      : {}),
    ...(raw.rateLimitWindowMs !== undefined
      ? { rateLimitWindowMs: raw.rateLimitWindowMs }
      : {}),
    ...(raw.allowlist !== undefined ? { allowlist: raw.allowlist } : {}),
    ...(raw.defaultMaxDailyAtomic !== undefined
      ? { defaultMaxDailyAtomic: raw.defaultMaxDailyAtomic }
      : {}),
    ...(raw.budgetWindow !== undefined
      ? { budgetWindow: raw.budgetWindow }
      : {}),
    ...(raw.budgetsPath !== undefined ? { budgetsPath: raw.budgetsPath } : {}),
  });

  if (!parsed.success) {
    throw new ConfigValidationError(
      parsed.error.issues.map((i) => {
        const path = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
        return `${path}${i.message}`;
      }),
    );
  }

  const v = parsed.data;
  const config: PaymcpEnvConfig = {
    facilitatorUrl: v.facilitatorUrl.replace(/\/$/, ""),
    payTo: v.payTo,
    network: v.network,
    asset: v.asset,
  };

  return {
    ...config,
    ...(v.facilitatorAuthToken !== undefined
      ? { facilitatorAuthToken: v.facilitatorAuthToken }
      : {}),
    ...(v.cdpApiKeyId !== undefined ? { cdpApiKeyId: v.cdpApiKeyId } : {}),
    ...(v.assetName !== undefined ? { assetName: v.assetName } : {}),
    ...(v.maxTimeoutSeconds !== undefined
      ? { maxTimeoutSeconds: v.maxTimeoutSeconds }
      : {}),
    ...(v.scheme !== undefined ? { scheme: v.scheme } : {}),
    ...(v.ledgerPath !== undefined ? { ledgerPath: v.ledgerPath } : {}),
    ...(v.databaseUrl !== undefined ? { databaseUrl: v.databaseUrl } : {}),
    ...(v.facilitatorTimeoutMs !== undefined
      ? { facilitatorTimeoutMs: v.facilitatorTimeoutMs }
      : {}),
    ...(v.facilitatorMaxRetries !== undefined
      ? { facilitatorMaxRetries: v.facilitatorMaxRetries }
      : {}),
    ...(v.rateLimitMax !== undefined ? { rateLimitMax: v.rateLimitMax } : {}),
    ...(v.rateLimitWindowMs !== undefined
      ? { rateLimitWindowMs: v.rateLimitWindowMs }
      : {}),
    ...(v.allowlist !== undefined ? { allowlist: v.allowlist } : {}),
    ...(v.defaultMaxDailyAtomic !== undefined
      ? { defaultMaxDailyAtomic: v.defaultMaxDailyAtomic }
      : {}),
    ...(v.budgetWindow !== undefined ? { budgetWindow: v.budgetWindow } : {}),
    ...(v.budgetsPath !== undefined ? { budgetsPath: v.budgetsPath } : {}),
  };
}

function optionalEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return value.trim();
}

function parsePositiveInt(
  raw: string | undefined,
  key: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigValidationError([`${key} must be a positive integer`]);
  }
  return n;
}

function parseNonNegInt(
  raw: string | undefined,
  key: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new ConfigValidationError([
      `${key} must be a non-negative integer`,
    ]);
  }
  return n;
}
