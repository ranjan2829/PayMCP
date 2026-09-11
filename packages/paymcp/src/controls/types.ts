/** Production access controls: tool allowlist + per-tool (optional per-tenant) daily budgets. */

export type BudgetWindow = "calendar_day_utc" | "rolling_24h";

export interface OperationBudget {
  readonly operationId: string;
  /** Max settled spend per window in atomic units (decimal string). */
  readonly maxDailyAtomic: string;
}

export interface TenantBudgets {
  readonly tenantId: string;
  readonly defaultMaxDailyAtomic?: string;
  readonly operations?: readonly OperationBudget[];
}

/**
 * budgets.yaml (or nested budgets: block in prices.yaml).
 *
 * Example:
 * ```yaml
 * version: 1
 * allowlist: [echoMessage, getWeather]
 * window: calendar_day_utc
 * defaultMaxDailyAtomic: "100000"
 * operations:
 *   - operationId: echoMessage
 *     maxDailyAtomic: "50000"
 * tenants:
 *   - tenantId: acme
 *     defaultMaxDailyAtomic: "200000"
 *     operations:
 *       - operationId: echoMessage
 *         maxDailyAtomic: "30000"
 * ```
 */
export interface BudgetsFile {
  readonly version: 1;
  readonly allowlist?: readonly string[];
  readonly window?: BudgetWindow;
  readonly defaultMaxDailyAtomic?: string;
  readonly operations?: readonly OperationBudget[];
  readonly tenants?: readonly TenantBudgets[];
}

export interface AccessControls {
  /**
   * When set (non-empty), only these operationIds may be paid/exposed.
   * When undefined, allowlist is disabled (all ops allowed — backward compatible).
   */
  readonly allowlist: ReadonlySet<string> | undefined;
  /** Calendar-day UTC (default) or rolling 24h window for spend caps. */
  readonly window: BudgetWindow;
  /** Global default max when no per-op / per-tenant override. */
  readonly defaultMaxDailyAtomic: bigint | undefined;
  /** operationId → maxDailyAtomic */
  readonly byOperationId: ReadonlyMap<string, bigint>;
  /** tenantId → budgets */
  readonly byTenant: ReadonlyMap<
    string,
    {
      readonly defaultMaxDailyAtomic: bigint | undefined;
      readonly byOperationId: ReadonlyMap<string, bigint>;
    }
  >;
}

export type AllowlistDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly error: "operation_not_allowlisted" };

export type BudgetDecision =
  | { readonly ok: true; readonly max: bigint | undefined; readonly spent: bigint }
  | {
      readonly ok: false;
      readonly error: "budget_exceeded";
      readonly max: bigint;
      readonly spent: bigint;
      readonly requested: bigint;
    };
