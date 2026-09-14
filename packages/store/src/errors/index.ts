/** Typed store errors — no stringly-typed throws at API boundaries. */

export type StoreErrorCode =
  | "LISTING_NOT_FOUND"
  | "LISTING_INVALID"
  | "LISTING_INACTIVE"
  | "BUYER_NOT_FOUND"
  | "INSUFFICIENT_BALANCE"
  | "IDEMPOTENCY_IN_FLIGHT"
  | "IDEMPOTENCY_REPLAY"
  | "UPSTREAM_FAILED"
  | "FUNDING_DISABLED"
  | "PAYOUT_FAILED"
  | "VALIDATION"
  | "INTERNAL";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly statusCode: number;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: StoreErrorCode,
    message: string,
    statusCode: number,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    this.statusCode = statusCode;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function isStoreError(err: unknown): err is StoreError {
  return err instanceof StoreError;
}
