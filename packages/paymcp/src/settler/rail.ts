import { z } from "zod";
import type { SettlementRail } from "../types/x402.js";

export type { SettlementRail };

/** Listing / paywall option: fixed rail or auto-select. */
export const RailPreferenceSchema = z.enum(["x402", "visa", "auto"]);
export type RailPreference = z.infer<typeof RailPreferenceSchema>;

export const SettlementRailSchema = z.enum(["x402", "visa"]);

export interface ResolveRailInput {
  readonly preference: RailPreference;
  /** True when a valid TAP agent signature is present. */
  readonly tapPresent?: boolean;
  /** True when VisaVicSettler is configured and ready. */
  readonly visaEnabled?: boolean;
  /** True when x402 facilitator is configured. */
  readonly x402Enabled?: boolean;
}

/**
 * Resolve which rail settles this request.
 * auto: prefer visa when TAP present + visa enabled; else x402; fail closed if none.
 */
export function resolveSettlementRail(input: ResolveRailInput): SettlementRail {
  const x402Ok = input.x402Enabled !== false;
  const visaOk = input.visaEnabled === true;

  if (input.preference === "x402") {
    if (!x402Ok) {
      throw new RailConfigError(
        "rail=x402 but facilitator / x402 settler is not configured",
      );
    }
    return "x402";
  }
  if (input.preference === "visa") {
    if (!visaOk) {
      throw new RailConfigError(
        "rail=visa but Visa VIC settler is not configured (set VISA_* env)",
      );
    }
    return "visa";
  }

  // auto
  if (input.tapPresent === true && visaOk) {
    return "visa";
  }
  if (x402Ok) {
    return "x402";
  }
  if (visaOk) {
    return "visa";
  }
  throw new RailConfigError(
    "rail=auto but neither x402 nor visa settler is available",
  );
}

export class RailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RailConfigError";
  }
}
