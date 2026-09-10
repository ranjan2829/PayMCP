import {
  X402_VERSION,
  type PaymentAccept,
  type PaymentRequired,
  type PaymentResource,
} from "../types/x402.js";
import type { PaymcpEnvConfig } from "../types/config.js";
import type { OperationPrice } from "../types/config.js";

export function buildPaymentAccept(
  config: PaymcpEnvConfig,
  price: OperationPrice,
): PaymentAccept {
  const accept: PaymentAccept = {
    scheme: config.scheme ?? "exact",
    network: config.network,
    amount: price.amount,
    asset: config.asset,
    payTo: config.payTo,
    maxTimeoutSeconds: config.maxTimeoutSeconds ?? 60,
  };
  if (config.assetName !== undefined) {
    return {
      ...accept,
      extra: { name: config.assetName, version: "2" },
    };
  }
  return accept;
}

export function buildPaymentRequired(args: {
  readonly config: PaymcpEnvConfig;
  readonly price: OperationPrice;
  readonly resource: PaymentResource;
  readonly error?: string;
}): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    error: args.error ?? "PAYMENT-SIGNATURE header is required",
    resource: args.resource,
    accepts: [buildPaymentAccept(args.config, args.price)],
  };
}

export function buildResource(args: {
  readonly url: string;
  readonly description: string;
  readonly mimeType?: string;
}): PaymentResource {
  return {
    url: args.url,
    description: args.description,
    mimeType: args.mimeType ?? "application/json",
  };
}
