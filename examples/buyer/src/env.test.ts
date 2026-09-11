import { describe, it, expect } from "vitest";
import {
  BuyerEnvError,
  buildTargetUrl,
  isLiveEnabled,
  parseBuyerConfig,
  parsePrivateKey,
  redactPrivateKey,
  requireLiveFlag,
} from "./env.js";

const KEY =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("buyer env (no chain)", () => {
  it("rejects missing live flag", () => {
    expect(() => requireLiveFlag({})).toThrow(BuyerEnvError);
    expect(isLiveEnabled({ PAYMCP_LIVE: "1" })).toBe(true);
    expect(isLiveEnabled({ PAYMCP_LIVE: "0" })).toBe(false);
  });

  it("validates private key shape without logging it", () => {
    expect(() => parsePrivateKey(undefined)).toThrow(/EVM_PRIVATE_KEY/);
    expect(() => parsePrivateKey("0xdead")).toThrow(/64 hex/);
    expect(parsePrivateKey(KEY)).toBe(KEY);
    expect(redactPrivateKey(KEY)).toMatch(/^0xaaaa…aaaa$/);
    expect(redactPrivateKey(KEY).includes("aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(
      false,
    );
  });

  it("builds echo URL and default POST body", () => {
    const cfg = parseBuyerConfig({
      PAYMCP_LIVE: "1",
      EVM_PRIVATE_KEY: KEY,
      DEMO_API_URL: "http://127.0.0.1:8787/",
      PAYMCP_FACILITATOR_URL: "https://x402.org/facilitator",
      PAYMCP_NETWORK: "eip155:84532",
    });
    expect(cfg.baseUrl).toBe("http://127.0.0.1:8787");
    expect(cfg.path).toBe("/echo");
    expect(cfg.method).toBe("POST");
    expect(cfg.body).toBe(JSON.stringify({ message: "hello from @x402/fetch" }));
    expect(cfg.facilitatorUrl).toBe("https://x402.org/facilitator");
    expect(cfg.networkPattern).toBe("eip155:84532");
    expect(buildTargetUrl(cfg.baseUrl, cfg.path)).toBe(
      "http://127.0.0.1:8787/echo",
    );
  });

  it("defaults weather to GET without a body", () => {
    const cfg = parseBuyerConfig({
      PAYMCP_LIVE: "1",
      EVM_PRIVATE_KEY: KEY,
      PAYMCP_BUYER_PATH: "weather",
    });
    expect(cfg.path).toBe("/weather");
    expect(cfg.method).toBe("GET");
    expect(cfg.body).toBeUndefined();
  });
});
