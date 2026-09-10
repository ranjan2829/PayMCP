import { describe, it, expect } from "vitest";
import {
  loadConfigFromEnv,
  ConfigValidationError,
} from "../../src/types/config.js";

describe("loadConfigFromEnv", () => {
  const base = {
    PAYMCP_FACILITATOR_URL: "https://x402.org/facilitator",
    PAYMCP_PAY_TO: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    PAYMCP_NETWORK: "eip155:84532",
    PAYMCP_ASSET: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  };

  it("loads valid config", () => {
    const cfg = loadConfigFromEnv(base);
    expect(cfg.facilitatorUrl).toBe("https://x402.org/facilitator");
    expect(cfg.network).toBe("eip155:84532");
  });

  it("fails fast with clear message when required env missing", () => {
    expect(() => loadConfigFromEnv({})).toThrow(ConfigValidationError);
    try {
      loadConfigFromEnv({});
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const msg = (err as ConfigValidationError).message;
      expect(msg).toContain("PAYMCP_FACILITATOR_URL");
      expect(msg).toContain("PAYMCP_PAY_TO");
      expect(msg).toContain("PAYMCP_NETWORK");
      expect(msg).toContain("PAYMCP_ASSET");
    }
  });

  it("rejects invalid CAIP-2 network", () => {
    expect(() =>
      loadConfigFromEnv({ ...base, PAYMCP_NETWORK: "not-caip2" }),
    ).toThrow(ConfigValidationError);
  });

  it("accepts optional postgres URL", () => {
    const cfg = loadConfigFromEnv({
      ...base,
      PAYMCP_DATABASE_URL: "postgres://u:p@localhost:5432/paymcp",
    });
    expect(cfg.databaseUrl).toContain("postgres://");
  });
});
