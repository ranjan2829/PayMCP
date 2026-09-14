import { describe, it, expect } from "vitest";
import {
  VisaVicSettler,
  loadVisaVicConfigFromEnv,
  ConfigValidationError,
  buildXPayToken,
  parseVisaPaymentPayload,
} from "../../src/index.js";
import {
  createVisaFixtureFetch,
  FIXTURE_VISA_PAYMENT,
  FIXTURE_VISA_SETTLE_FAIL,
} from "../fixtures/visa.js";

describe("VisaVicSettler", () => {
  const clientOpts = {
    apiBaseUrl: "https://cert.api.visa.example",
    apiKey: "test-api-key-not-for-prod",
    sharedSecret: "test-shared-secret-not-for-prod",
    nowSeconds: () => 1_700_000_000,
  };

  it("verifyAndSettle succeeds against fixture HTTP protocol", async () => {
    const settler = new VisaVicSettler({
      ...clientOpts,
      fetchImpl: createVisaFixtureFetch({ verifyValid: true }),
    });
    const result = await settler.verifyAndSettle({
      payment: FIXTURE_VISA_PAYMENT,
      idempotencyKey: "idem-1",
    });
    expect(result.success).toBe(true);
    expect(result.rail).toBe("visa");
    expect(result.transaction.length).toBeGreaterThan(5);
  });

  it("returns failure when verify rejects", async () => {
    const settler = new VisaVicSettler({
      ...clientOpts,
      fetchImpl: createVisaFixtureFetch({ verifyValid: false }),
    });
    const result = await settler.verifyAndSettle({
      payment: FIXTURE_VISA_PAYMENT,
      idempotencyKey: "idem-2",
    });
    expect(result.success).toBe(false);
    expect(result.rail).toBe("visa");
    expect(result.errorReason).toBe("invalid_credential");
  });

  it("propagates settle failure", async () => {
    const settler = new VisaVicSettler({
      ...clientOpts,
      fetchImpl: createVisaFixtureFetch({
        verifyValid: true,
        settle: FIXTURE_VISA_SETTLE_FAIL,
      }),
    });
    const result = await settler.verifyAndSettle({
      payment: FIXTURE_VISA_PAYMENT,
      idempotencyKey: "idem-3",
    });
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("credential_declined");
  });

  it("sends X-Pay token on fixture requests", async () => {
    const settler = new VisaVicSettler({
      ...clientOpts,
      fetchImpl: createVisaFixtureFetch({ requireXPay: true }),
    });
    const result = await settler.settle({
      payment: FIXTURE_VISA_PAYMENT,
      idempotencyKey: "idem-4",
    });
    expect(result.success).toBe(true);
  });
});

describe("loadVisaVicConfigFromEnv", () => {
  it("returns disabled without requiring secrets", () => {
    expect(loadVisaVicConfigFromEnv({}).enabled).toBe(false);
  });

  it("refuses boot when enabled but secrets unset", () => {
    expect(() =>
      loadVisaVicConfigFromEnv({ PAYMCP_VISA_ENABLED: "1" }),
    ).toThrow(ConfigValidationError);
  });

  it("loads when all required Visa env present", () => {
    const cfg = loadVisaVicConfigFromEnv({
      PAYMCP_VISA_ENABLED: "1",
      VISA_API_BASE_URL: "https://cert.api.visa.com",
      VISA_API_KEY: "from-operator-dashboard",
      VISA_SHARED_SECRET: "from-operator-dashboard",
    });
    expect(cfg.enabled).toBe(true);
    if (cfg.enabled) {
      expect(cfg.apiBaseUrl).toBe("https://cert.api.visa.com");
    }
  });
});

describe("buildXPayToken", () => {
  it("matches xv2:timestamp:hmac shape", () => {
    const token = buildXPayToken({
      sharedSecret: "secret",
      timestampSeconds: 100,
      resourcePath: "/vic/v1/payments/settle",
      queryString: "apikey=k",
      body: "{}",
    });
    expect(token.startsWith("xv2:100:")).toBe(true);
    expect(token.split(":")).toHaveLength(3);
  });
});

describe("parseVisaPaymentPayload", () => {
  it("accepts version 1 payload", () => {
    const p = parseVisaPaymentPayload(FIXTURE_VISA_PAYMENT);
    expect(p.credentialRef).toContain("vic_cred");
  });

  it("rejects bad version", () => {
    expect(() =>
      parseVisaPaymentPayload({ ...FIXTURE_VISA_PAYMENT, version: 2 }),
    ).toThrow(/version/);
  });
});
