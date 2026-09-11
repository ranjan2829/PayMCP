import type { PaymcpEnvConfig, PricesFile } from "../types/config.js";
import type { Ledger } from "../ledger/types.js";
import type {
  AccessControls,
  AllowlistDecision,
  BudgetDecision,
  BudgetWindow,
  BudgetsFile,
} from "./types.js";
import { parseAllowlistEnv } from "./parse.js";

export interface ResolveAccessControlsInput {
  readonly config: PaymcpEnvConfig;
  readonly pricesFile?: PricesFile;
  readonly budgetsFile?: BudgetsFile;
  /** Explicit CLI / constructor allowlist (merged; env wins when set). */
  readonly explicitAllowlist?: readonly string[];
}

/**
 * Build access controls from env + prices.yaml + budgets.yaml.
 *
 * Allowlist precedence (first non-empty wins):
 *   1. PAYMCP_ALLOWLIST env
 *   2. explicitAllowlist (CLI --allow / options)
 *   3. prices.yaml allowlist
 *   4. budgets.yaml allowlist
 *
 * Budget precedence for a given (tenant?, operationId):
 *   tenant.operations[op] > tenant.default > operations[op] > defaultMaxDailyAtomic
 * Env PAYMCP_DEFAULT_MAX_DAILY_ATOMIC overrides file default when set.
 */
export function resolveAccessControls(
  input: ResolveAccessControlsInput,
): AccessControls {
  const envAllow = parseAllowlistEnv(input.config.allowlist);
  const pricesAllow = input.pricesFile?.allowlist;
  const budgetsAllow = input.budgetsFile?.allowlist;
  const explicit = input.explicitAllowlist;

  let allowlist: ReadonlySet<string> | undefined;
  if (envAllow !== undefined && envAllow.length > 0) {
    allowlist = new Set(envAllow);
  } else if (explicit !== undefined && explicit.length > 0) {
    allowlist = new Set(explicit);
  } else if (pricesAllow !== undefined && pricesAllow.length > 0) {
    allowlist = new Set(pricesAllow);
  } else if (budgetsAllow !== undefined && budgetsAllow.length > 0) {
    allowlist = new Set(budgetsAllow);
  }

  const window: BudgetWindow =
    input.config.budgetWindow ??
    input.budgetsFile?.window ??
    "calendar_day_utc";

  const byOperationId = new Map<string, bigint>();

  // prices.yaml per-op maxDailyAtomic
  if (input.pricesFile !== undefined) {
    for (const op of input.pricesFile.operations) {
      if (op.maxDailyAtomic !== undefined) {
        byOperationId.set(op.operationId, BigInt(op.maxDailyAtomic));
      }
    }
  }
  // budgets.yaml operations override prices
  if (input.budgetsFile?.operations !== undefined) {
    for (const op of input.budgetsFile.operations) {
      byOperationId.set(op.operationId, BigInt(op.maxDailyAtomic));
    }
  }

  let defaultMaxDailyAtomic: bigint | undefined;
  if (input.budgetsFile?.defaultMaxDailyAtomic !== undefined) {
    defaultMaxDailyAtomic = BigInt(input.budgetsFile.defaultMaxDailyAtomic);
  }
  if (input.config.defaultMaxDailyAtomic !== undefined) {
    defaultMaxDailyAtomic = BigInt(input.config.defaultMaxDailyAtomic);
  }

  const byTenant = new Map<
    string,
    {
      readonly defaultMaxDailyAtomic: bigint | undefined;
      readonly byOperationId: ReadonlyMap<string, bigint>;
    }
  >();
  if (input.budgetsFile?.tenants !== undefined) {
    for (const t of input.budgetsFile.tenants) {
      const opMap = new Map<string, bigint>();
      if (t.operations !== undefined) {
        for (const op of t.operations) {
          opMap.set(op.operationId, BigInt(op.maxDailyAtomic));
        }
      }
      byTenant.set(t.tenantId, {
        defaultMaxDailyAtomic:
          t.defaultMaxDailyAtomic !== undefined
            ? BigInt(t.defaultMaxDailyAtomic)
            : undefined,
        byOperationId: opMap,
      });
    }
  }

  return {
    allowlist,
    window,
    defaultMaxDailyAtomic,
    byOperationId,
    byTenant,
  };
}

export function checkAllowlist(
  controls: AccessControls,
  operationId: string,
): AllowlistDecision {
  if (controls.allowlist === undefined) {
    return { allowed: true };
  }
  if (controls.allowlist.has(operationId)) {
    return { allowed: true };
  }
  return { allowed: false, error: "operation_not_allowlisted" };
}

/** Resolve the max daily atomic budget for an operation (and optional tenant). */
export function resolveMaxDailyAtomic(
  controls: AccessControls,
  operationId: string,
  tenantId?: string,
): bigint | undefined {
  if (tenantId !== undefined) {
    const tenant = controls.byTenant.get(tenantId);
    if (tenant !== undefined) {
      const perOp = tenant.byOperationId.get(operationId);
      if (perOp !== undefined) {
        return perOp;
      }
      if (tenant.defaultMaxDailyAtomic !== undefined) {
        return tenant.defaultMaxDailyAtomic;
      }
    }
  }
  const perOp = controls.byOperationId.get(operationId);
  if (perOp !== undefined) {
    return perOp;
  }
  return controls.defaultMaxDailyAtomic;
}

export function windowStartIso(
  window: BudgetWindow,
  now: Date = new Date(),
): string {
  if (window === "rolling_24h") {
    return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  }
  // calendar_day_utc: midnight UTC today
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}T00:00:00.000Z`;
}

/**
 * Hard-stop check: spent (settled) + requested must not exceed max.
 * When no max is configured, always ok.
 */
export async function checkBudget(args: {
  readonly controls: AccessControls;
  readonly ledger: Ledger;
  readonly operationId: string;
  readonly requestedAtomic: string;
  readonly tenantId?: string;
  readonly now?: Date;
}): Promise<BudgetDecision> {
  const max = resolveMaxDailyAtomic(
    args.controls,
    args.operationId,
    args.tenantId,
  );
  const spent = await args.ledger.sumSettledAtomic({
    operationId: args.operationId,
    sinceIso: windowStartIso(args.controls.window, args.now ?? new Date()),
    ...(args.tenantId !== undefined ? { tenantId: args.tenantId } : {}),
  });

  if (max === undefined) {
    return { ok: true, max: undefined, spent };
  }

  const requested = BigInt(args.requestedAtomic);
  if (spent + requested > max) {
    return {
      ok: false,
      error: "budget_exceeded",
      max,
      spent,
      requested,
    };
  }
  return { ok: true, max, spent };
}

export function emptyAccessControls(): AccessControls {
  return {
    allowlist: undefined,
    window: "calendar_day_utc",
    defaultMaxDailyAtomic: undefined,
    byOperationId: new Map(),
    byTenant: new Map(),
  };
}
