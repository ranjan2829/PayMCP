import { readFileSync } from "node:fs";
import YAML from "js-yaml";
import { isRecord } from "../headers/codec.js";
import type {
  BudgetWindow,
  BudgetsFile,
  OperationBudget,
  TenantBudgets,
} from "./types.js";

export function loadBudgetsFile(path: string): BudgetsFile {
  const rawText = readFileSync(path, "utf8");
  const raw = YAML.load(rawText) as unknown;
  return parseBudgetsFile(raw);
}

export function parseBudgetsFile(raw: unknown): BudgetsFile {
  if (!isRecord(raw)) {
    throw new Error("budgets file must be an object");
  }
  if (raw["version"] !== 1) {
    throw new Error("budgets file version must be 1");
  }

  const allowlist = parseAllowlistField(raw["allowlist"], "budgets.allowlist");
  const window = parseWindow(raw["window"]);
  const defaultMaxDailyAtomic = parseAtomicOptional(
    raw["defaultMaxDailyAtomic"],
    "budgets.defaultMaxDailyAtomic",
  );
  const operations = parseOperationBudgets(
    raw["operations"],
    "budgets.operations",
  );
  const tenants = parseTenants(raw["tenants"]);

  const result: BudgetsFile = { version: 1 };
  return {
    ...result,
    ...(allowlist !== undefined ? { allowlist } : {}),
    ...(window !== undefined ? { window } : {}),
    ...(defaultMaxDailyAtomic !== undefined
      ? { defaultMaxDailyAtomic }
      : {}),
    ...(operations !== undefined ? { operations } : {}),
    ...(tenants !== undefined ? { tenants } : {}),
  };
}

export function parseAllowlistField(
  raw: unknown,
  label: string,
): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new Error(`${label} must be an array of operationId strings`);
  }
  const ids: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`${label}[${i}] must be a non-empty string`);
    }
    ids.push(item.trim());
  }
  return ids;
}

export function parseAtomicString(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new Error(`${label} must be a decimal integer string`);
  }
  return raw;
}

function parseAtomicOptional(
  raw: unknown,
  label: string,
): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return parseAtomicString(raw, label);
}

function parseWindow(raw: unknown): BudgetWindow | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === "calendar_day_utc" || raw === "rolling_24h") {
    return raw;
  }
  throw new Error(
    `budgets.window must be "calendar_day_utc" or "rolling_24h"`,
  );
}

function parseOperationBudgets(
  raw: unknown,
  label: string,
): OperationBudget[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new Error(`${label} must be an array`);
  }
  return raw.map((item, i) => {
    if (!isRecord(item)) {
      throw new Error(`${label}[${i}] must be an object`);
    }
    const operationId = item["operationId"];
    if (typeof operationId !== "string" || operationId.length === 0) {
      throw new Error(`${label}[${i}].operationId required`);
    }
    const maxDailyAtomic = parseAtomicString(
      item["maxDailyAtomic"],
      `${label}[${i}].maxDailyAtomic`,
    );
    return { operationId, maxDailyAtomic };
  });
}

function parseTenants(raw: unknown): TenantBudgets[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new Error("budgets.tenants must be an array");
  }
  return raw.map((item, i) => {
    if (!isRecord(item)) {
      throw new Error(`budgets.tenants[${i}] must be an object`);
    }
    const tenantId = item["tenantId"];
    if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
      throw new Error(`budgets.tenants[${i}].tenantId required`);
    }
    const defaultMaxDailyAtomic = parseAtomicOptional(
      item["defaultMaxDailyAtomic"],
      `budgets.tenants[${i}].defaultMaxDailyAtomic`,
    );
    const operations = parseOperationBudgets(
      item["operations"],
      `budgets.tenants[${i}].operations`,
    );
    return {
      tenantId: tenantId.trim(),
      ...(defaultMaxDailyAtomic !== undefined
        ? { defaultMaxDailyAtomic }
        : {}),
      ...(operations !== undefined ? { operations } : {}),
    };
  });
}

/** Parse comma-separated operationIds from PAYMCP_ALLOWLIST. */
export function parseAllowlistEnv(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ids.length > 0 ? ids : undefined;
}
