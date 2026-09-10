import { readFileSync } from "node:fs";
import YAML from "js-yaml";
import type { CompiledOperation } from "../types/openapi.js";
import type { OperationPrice, PricesFile, XPaymcpExtension } from "../types/config.js";
import { isRecord } from "../headers/codec.js";

export interface PriceTable {
  /** operationId → price; missing means not in allowlist (rejected for paid MCP). */
  readonly byOperationId: ReadonlyMap<string, OperationPrice>;
}

/**
 * Build price table from OpenAPI x-paymcp extensions, optionally overridden
 * by prices.yaml (file wins on conflict).
 */
export function buildPriceTable(
  operations: readonly CompiledOperation[],
  pricesFile?: PricesFile,
): PriceTable {
  const map = new Map<string, OperationPrice>();

  for (const op of operations) {
    if (op.amount === undefined) {
      continue;
    }
    map.set(op.operationId, {
      operationId: op.operationId,
      amount: op.amount,
      paid: op.paid,
      ...(op.description.length > 0
        ? { description: op.description }
        : {}),
    });
  }

  if (pricesFile !== undefined) {
    for (const entry of pricesFile.operations) {
      map.set(entry.operationId, entry);
    }
  }

  return { byOperationId: map };
}

export function loadPricesFile(path: string): PricesFile {
  const rawText = readFileSync(path, "utf8");
  const raw = YAML.load(rawText) as unknown;
  return parsePricesFile(raw);
}

export function parsePricesFile(raw: unknown): PricesFile {
  if (!isRecord(raw)) {
    throw new Error("prices file must be an object");
  }
  if (raw["version"] !== 1) {
    throw new Error("prices file version must be 1");
  }
  const operationsRaw = raw["operations"];
  if (!Array.isArray(operationsRaw)) {
    throw new Error("prices.operations must be an array");
  }
  const operations: OperationPrice[] = operationsRaw.map((item, i) => {
    if (!isRecord(item)) {
      throw new Error(`prices.operations[${i}] must be an object`);
    }
    const operationId = item["operationId"];
    const amount = item["amount"];
    if (typeof operationId !== "string" || operationId.length === 0) {
      throw new Error(`prices.operations[${i}].operationId required`);
    }
    if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
      throw new Error(
        `prices.operations[${i}].amount must be a decimal integer string`,
      );
    }
    const description = item["description"];
    const paid = item["paid"];
    const base: OperationPrice = { operationId, amount };
    const withDesc: OperationPrice =
      typeof description === "string"
        ? { ...base, description }
        : base;
    if (paid === undefined) {
      return withDesc;
    }
    if (typeof paid !== "boolean") {
      throw new Error(`prices.operations[${i}].paid must be boolean`);
    }
    return { ...withDesc, paid };
  });
  return { version: 1, operations };
}

export function parseXPaymcpExtension(raw: unknown): XPaymcpExtension | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new Error("x-paymcp must be an object");
  }
  const amount = raw["amount"];
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
    throw new Error("x-paymcp.amount must be a decimal integer string");
  }
  const description = raw["description"];
  const paid = raw["paid"];
  const base: XPaymcpExtension = { amount };
  const withDesc: XPaymcpExtension =
    typeof description === "string" ? { ...base, description } : base;
  if (paid === undefined) {
    return withDesc;
  }
  if (typeof paid !== "boolean") {
    throw new Error("x-paymcp.paid must be boolean");
  }
  return { ...withDesc, paid };
}

export function isOperationPaid(
  table: PriceTable,
  operationId: string,
): { paid: true; price: OperationPrice } | { paid: false } {
  const price = table.byOperationId.get(operationId);
  if (price === undefined) {
    return { paid: false };
  }
  if (price.paid === false) {
    return { paid: false };
  }
  return { paid: true, price };
}
