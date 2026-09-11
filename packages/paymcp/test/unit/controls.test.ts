import { describe, it, expect } from "vitest";
import { parseBudgetsFile, parseAllowlistEnv } from "../../src/controls/parse.js";
import {
  resolveAccessControls,
  checkAllowlist,
  resolveMaxDailyAtomic,
  windowStartIso,
} from "../../src/controls/resolve.js";
import { parsePricesFile } from "../../src/pricing/resolve.js";
import type { PaymcpEnvConfig } from "../../src/types/config.js";

const config: PaymcpEnvConfig = {
  facilitatorUrl: "https://x402.org/facilitator",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

describe("controls parse/resolve", () => {
  it("parses allowlist env", () => {
    expect(parseAllowlistEnv("a, b")).toEqual(["a", "b"]);
    expect(parseAllowlistEnv(undefined)).toBeUndefined();
  });

  it("parses budgets.yaml shape", () => {
    const file = parseBudgetsFile({
      version: 1,
      allowlist: ["echoMessage"],
      window: "calendar_day_utc",
      defaultMaxDailyAtomic: "100000",
      operations: [{ operationId: "echoMessage", maxDailyAtomic: "50000" }],
    });
    expect(file.allowlist).toEqual(["echoMessage"]);
    expect(file.operations?.[0]?.maxDailyAtomic).toBe("50000");
  });

  it("env allowlist wins over prices.yaml", () => {
    const prices = parsePricesFile({
      version: 1,
      allowlist: ["fromPrices"],
      operations: [{ operationId: "fromPrices", amount: "1" }],
    });
    const controls = resolveAccessControls({
      config: { ...config, allowlist: "fromEnv" },
      pricesFile: prices,
    });
    expect(checkAllowlist(controls, "fromEnv").allowed).toBe(true);
    expect(checkAllowlist(controls, "fromPrices").allowed).toBe(false);
  });

  it("resolves per-op budget over default", () => {
    const prices = parsePricesFile({
      version: 1,
      operations: [
        { operationId: "echoMessage", amount: "10000", maxDailyAtomic: "50000" },
      ],
    });
    const controls = resolveAccessControls({
      config: { ...config, defaultMaxDailyAtomic: "100000" },
      pricesFile: prices,
    });
    expect(resolveMaxDailyAtomic(controls, "echoMessage")).toBe(50000n);
    expect(resolveMaxDailyAtomic(controls, "other")).toBe(100000n);
  });

  it("windowStartIso calendar day is UTC midnight", () => {
    const now = new Date("2026-09-12T15:30:00.000Z");
    expect(windowStartIso("calendar_day_utc", now)).toBe(
      "2026-09-12T00:00:00.000Z",
    );
  });
});
