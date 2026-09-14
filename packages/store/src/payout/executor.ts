import {
  FacilitatorSettler,
  X402_VERSION,
  type PaymentAccept,
  type PaymentPayload,
  type PaymentResource,
} from "openapi-to-paymcp";
import type { SellerPayout } from "./queue.js";
import { StoreError } from "../errors/index.js";

export interface PayoutExecutionResult {
  readonly transaction: string;
  readonly network: string;
  readonly payer: string;
}

/**
 * Executes a real seller payout to listing.payTo.
 * Implementations must move funds (facilitator settle or on-chain transfer) — no stubs.
 */
export interface SellerPayoutExecutor {
  execute(payout: SellerPayout): Promise<PayoutExecutionResult>;
}

export type PaymentPayloadBuilder = (
  requirements: PaymentAccept,
  resource: PaymentResource,
) => Promise<PaymentPayload>;

export interface FacilitatorPayoutOptions {
  readonly facilitatorUrl: string;
  readonly authToken?: string;
  readonly asset: string;
  readonly assetName?: string;
  readonly maxTimeoutSeconds?: number;
  readonly buildPaymentPayload: PaymentPayloadBuilder;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Pays the seller via real facilitator verify+settle to listing.payTo.
 * Operator must supply buildPaymentPayload (EIP-3009 ExactEvm signature).
 */
export class FacilitatorSellerPayout implements SellerPayoutExecutor {
  private readonly settler: FacilitatorSettler;
  private readonly asset: string;
  private readonly assetName: string | undefined;
  private readonly maxTimeoutSeconds: number;
  private readonly buildPaymentPayload: PaymentPayloadBuilder;

  constructor(options: FacilitatorPayoutOptions) {
    this.settler = new FacilitatorSettler({
      baseUrl: options.facilitatorUrl,
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
    this.asset = options.asset;
    this.assetName = options.assetName;
    this.maxTimeoutSeconds = options.maxTimeoutSeconds ?? 60;
    this.buildPaymentPayload = options.buildPaymentPayload;
  }

  async execute(payout: SellerPayout): Promise<PayoutExecutionResult> {
    if (payout.status === "paid" && payout.transaction) {
      return {
        transaction: payout.transaction,
        network: payout.network,
        payer: "",
      };
    }
    const requirements: PaymentAccept = {
      scheme: "exact",
      network: payout.network,
      amount: payout.amount,
      asset: payout.asset || this.asset,
      payTo: payout.payTo,
      maxTimeoutSeconds: this.maxTimeoutSeconds,
      ...(this.assetName !== undefined
        ? { extra: { name: this.assetName, version: "2" } }
        : {}),
    };
    const resource: PaymentResource = {
      url: `paymcp-store://payout/${payout.id}`,
      description: `Seller payout for spend ${payout.spendId}`,
      mimeType: "application/json",
    };
    const paymentPayload = await this.buildPaymentPayload(requirements, resource);
    if (paymentPayload.x402Version !== X402_VERSION) {
      throw new StoreError("INTERNAL", "payment payload x402Version mismatch", 500);
    }
    // Enforce payTo from listing — never settle to a different address.
    if (paymentPayload.accepted.payTo.toLowerCase() !== payout.payTo.toLowerCase()) {
      throw new StoreError(
        "INTERNAL",
        "payment payload payTo does not match listing payTo",
        500,
      );
    }
    const settled = await this.settler.verifyAndSettle({
      paymentPayload,
      paymentRequirements: requirements,
    });
    if (!settled.success || !settled.transaction) {
      throw new StoreError(
        "INTERNAL",
        `facilitator payout failed: ${settled.errorReason ?? "unknown"}`,
        502,
        { payoutId: payout.id },
      );
    }
    return {
      transaction: settled.transaction,
      network: settled.network,
      payer: settled.payer,
    };
  }
}

/** Test / injectable executor that records calls (not for product serve). */
export class RecordingPayoutExecutor implements SellerPayoutExecutor {
  readonly calls: SellerPayout[] = [];
  constructor(
    private readonly result: PayoutExecutionResult = {
      transaction: "0xtest_payout",
      network: "eip155:84532",
      payer: "0xoperator",
    },
  ) {}
  async execute(payout: SellerPayout): Promise<PayoutExecutionResult> {
    this.calls.push(payout);
    return {
      ...this.result,
      network: payout.network,
    };
  }
}
