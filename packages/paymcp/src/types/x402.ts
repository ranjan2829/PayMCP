/**
 * x402 V2 wire types (HTTP transport headers).
 * Adapter over 402 semantics — not a new payment protocol.
 * @see https://docs.x402.org/core-concepts/http-402
 */

export const X402_VERSION = 2 as const;

export type PaymentScheme = "exact" | "upto";

/** CAIP-2 network id, e.g. eip155:84532 (Base Sepolia), eip155:8453 (Base). */
export type Caip2Network = string;

export interface PaymentResource {
  readonly url: string;
  readonly description: string;
  readonly mimeType: string;
}

export interface PaymentAccept {
  readonly scheme: PaymentScheme;
  readonly network: Caip2Network;
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra?: Readonly<Record<string, string>>;
}

export interface PaymentRequired {
  readonly x402Version: typeof X402_VERSION;
  readonly error: string;
  readonly resource: PaymentResource;
  readonly accepts: readonly PaymentAccept[];
}

export interface ExactEvmAuthorization {
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly nonce: string;
}

export interface ExactEvmPayload {
  readonly signature: string;
  readonly authorization: ExactEvmAuthorization;
}

export interface PaymentPayload {
  readonly x402Version: typeof X402_VERSION;
  readonly resource: PaymentResource;
  readonly accepted: PaymentAccept;
  readonly payload: ExactEvmPayload | Readonly<Record<string, unknown>>;
}

/** Which settlement rail produced this receipt (x402 USDC or Visa VIC). */
export type SettlementRail = "x402" | "visa";

export interface SettlementResponse {
  readonly success: boolean;
  readonly transaction: string;
  readonly network: Caip2Network;
  readonly payer: string;
  readonly errorReason?: string;
  /** Set by dual-rail paywall / VisaVicSettler when known. */
  readonly rail?: SettlementRail;
}

export interface FacilitatorVerifyRequest {
  readonly x402Version: typeof X402_VERSION;
  readonly paymentPayload: PaymentPayload;
  readonly paymentRequirements: PaymentAccept;
}

export interface FacilitatorVerifyResponse {
  readonly isValid: boolean;
  readonly invalidReason?: string;
  readonly payer?: string;
}

export interface FacilitatorSettleRequest {
  readonly x402Version: typeof X402_VERSION;
  readonly paymentPayload: PaymentPayload;
  readonly paymentRequirements: PaymentAccept;
}

export type FacilitatorSettleResponse = SettlementResponse;
