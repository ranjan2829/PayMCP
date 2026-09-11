/**
 * Thin wrapper around the official x402 V2 fetch client.
 *
 * PayMCP is an adapter: this example pays with @x402/fetch, not a new protocol.
 * The buyer signs PAYMENT-SIGNATURE locally; the PayMCP server verifies and
 * settles through its real facilitator after a 2xx handler.
 */
import {
  wrapFetchWithPayment,
  x402Client,
  decodePaymentResponseHeader,
} from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

export interface CreatePaidFetchOptions {
  readonly privateKey: `0x${string}`;
  readonly networkPattern?: `${string}:${string}`;
  readonly fetchImpl?: typeof fetch;
  readonly maxAmountPerPayment?: string;
}

export function createPaidFetch(
  options: CreatePaidFetchOptions,
): typeof fetch {
  const signer = privateKeyToAccount(options.privateKey);
  const network: `${string}:${string}` = options.networkPattern ?? "eip155:*";
  const client = x402Client.fromConfig({
    schemes: [{ network, client: new ExactEvmScheme(signer) }],
    spendControls: {
      maxAmountPerPayment: options.maxAmountPerPayment ?? "$1",
    },
  });
  return wrapFetchWithPayment(options.fetchImpl ?? globalThis.fetch, client);
}

export function decodeJsonHeader(headerValue: string): unknown {
  const json = Buffer.from(headerValue, "base64").toString("utf8");
  return JSON.parse(json) as unknown;
}

export interface SettlementSummary {
  readonly present: boolean;
  readonly success?: boolean;
  readonly network?: string;
  readonly payer?: string;
  readonly transactionPrefix?: string;
  readonly errorReason?: string;
}

function settlementFromRecord(rec: Record<string, unknown>): SettlementSummary {
  const tx = typeof rec["transaction"] === "string" ? rec["transaction"] : "";
  return {
    present: true,
    success: rec["success"] === true,
    ...(typeof rec["network"] === "string" ? { network: rec["network"] } : {}),
    ...(typeof rec["payer"] === "string" ? { payer: rec["payer"] } : {}),
    ...(tx.length > 0 ? { transactionPrefix: `${tx.slice(0, 18)}…` } : {}),
    ...(typeof rec["errorReason"] === "string"
      ? { errorReason: rec["errorReason"] }
      : {}),
  };
}

/** Decode PAYMENT-RESPONSE without logging the full blob. */
export function summarizeSettlementHeader(
  header: string | null | undefined,
): SettlementSummary {
  if (header === undefined || header === null || header.length === 0) {
    return { present: false };
  }
  try {
    const decoded = decodePaymentResponseHeader(header);
    return settlementFromRecord({
      success: decoded.success,
      ...(typeof decoded.transaction === "string"
        ? { transaction: decoded.transaction }
        : {}),
      ...(typeof decoded.network === "string" ? { network: decoded.network } : {}),
      ...(typeof decoded.payer === "string" ? { payer: decoded.payer } : {}),
      ...(typeof decoded.errorReason === "string"
        ? { errorReason: decoded.errorReason }
        : {}),
    });
  } catch {
    try {
      const raw = decodeJsonHeader(header);
      if (raw !== null && typeof raw === "object") {
        return settlementFromRecord(raw as Record<string, unknown>);
      }
    } catch {
      // fall through
    }
    return { present: true };
  }
}

export function summarizeSignatureHeader(
  header: string | null | undefined,
): { present: boolean; length: number } {
  if (header === undefined || header === null || header.length === 0) {
    return { present: false, length: 0 };
  }
  return { present: true, length: header.length };
}

export interface PaymentRequiredSummary {
  readonly x402Version?: number;
  readonly error?: string;
  readonly resourceUrl?: string;
  readonly amount?: string;
  readonly network?: string;
  readonly asset?: string;
  readonly payTo?: string;
  readonly scheme?: string;
}

export function summarizePaymentRequiredHeader(
  header: string | null | undefined,
): PaymentRequiredSummary | undefined {
  if (header === undefined || header === null || header.length === 0) {
    return undefined;
  }
  const raw = decodeJsonHeader(header);
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  const accepts = rec["accepts"];
  const first =
    Array.isArray(accepts) && accepts[0] !== null && typeof accepts[0] === "object"
      ? (accepts[0] as Record<string, unknown>)
      : undefined;
  const resource =
    rec["resource"] !== null && typeof rec["resource"] === "object"
      ? (rec["resource"] as Record<string, unknown>)
      : undefined;
  return {
    ...(typeof rec["x402Version"] === "number"
      ? { x402Version: rec["x402Version"] }
      : {}),
    ...(typeof rec["error"] === "string" ? { error: rec["error"] } : {}),
    ...(typeof resource?.["url"] === "string"
      ? { resourceUrl: resource["url"] }
      : {}),
    ...(typeof first?.["amount"] === "string" ? { amount: first["amount"] } : {}),
    ...(typeof first?.["network"] === "string"
      ? { network: first["network"] }
      : {}),
    ...(typeof first?.["asset"] === "string" ? { asset: first["asset"] } : {}),
    ...(typeof first?.["payTo"] === "string" ? { payTo: first["payTo"] } : {}),
    ...(typeof first?.["scheme"] === "string" ? { scheme: first["scheme"] } : {}),
  };
}
