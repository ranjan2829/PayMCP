import { describe, it, expect } from "vitest";
import { resolveSettlementRail, RailConfigError } from "../../src/settler/rail.js";

describe("resolveSettlementRail", () => {
  it("honors explicit x402", () => {
    expect(
      resolveSettlementRail({ preference: "x402", x402Enabled: true }),
    ).toBe("x402");
  });

  it("honors explicit visa when enabled", () => {
    expect(
      resolveSettlementRail({ preference: "visa", visaEnabled: true }),
    ).toBe("visa");
  });

  it("fails closed for visa without settler", () => {
    expect(() =>
      resolveSettlementRail({ preference: "visa", visaEnabled: false }),
    ).toThrow(RailConfigError);
  });

  it("auto prefers visa when TAP present", () => {
    expect(
      resolveSettlementRail({
        preference: "auto",
        tapPresent: true,
        visaEnabled: true,
        x402Enabled: true,
      }),
    ).toBe("visa");
  });

  it("auto falls back to x402 without TAP", () => {
    expect(
      resolveSettlementRail({
        preference: "auto",
        tapPresent: false,
        visaEnabled: true,
        x402Enabled: true,
      }),
    ).toBe("x402");
  });
});
