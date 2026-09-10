import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paymcpPaywall } from "../../src/middleware/paywall.js";
import { FacilitatorSettler } from "../../src/settler/facilitator.js";
import { SqliteLedger } from "../../src/ledger/sqlite.js";
import { buildPriceTable, parsePricesFile } from "../../src/pricing/resolve.js";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  decodeHeaderPayload,
} from "../../src/headers/codec.js";
import { parsePaymentRequired, parseSettlementResponse } from "../../src/headers/validate.js";
import {
  createFacilitatorFixtureFetch,
  FIXTURE_SIGNATURE_HEADER,
  FIXTURE_ACCEPT,
} from "../fixtures/facilitator.js";
import type { PaymcpEnvConfig } from "../../src/types/config.js";

const config: PaymcpEnvConfig = {
  facilitatorUrl: "https://facilitator.example/x402",
  payTo: FIXTURE_ACCEPT.payTo,
  network: FIXTURE_ACCEPT.network,
  asset: FIXTURE_ACCEPT.asset,
  assetName: "USDC",
};

describe("paywall middleware (fixture facilitator)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  async function buildApp() {
    const dir = mkdtempSync(join(tmpdir(), "paymcp-pw-"));
    dirs.push(dir);
    const app = Fastify();
    const prices = buildPriceTable(
      [],
      parsePricesFile({
        version: 1,
        operations: [{ operationId: "echoMessage", amount: "10000" }],
      }),
    );
    const settler = new FacilitatorSettler({
      baseUrl: config.facilitatorUrl,
      fetchImpl: createFacilitatorFixtureFetch({}),
    });
    const ledger = new SqliteLedger(join(dir, "l.db"));
    await app.register(paymcpPaywall, {
      config,
      prices,
      settler,
      ledger,
      publicBaseUrl: "http://127.0.0.1:8787",
      operationIdForRequest: () => "echoMessage",
    });
    app.post("/echo", async () => ({ ok: true }));
    return app;
  }

  it("unpaid → 402 + PAYMENT-REQUIRED", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/echo", payload: {} });
    expect(res.statusCode).toBe(402);
    const header = res.headers[HEADER_PAYMENT_REQUIRED.toLowerCase()];
    expect(typeof header).toBe("string");
    const required = decodeHeaderPayload(
      String(header),
      parsePaymentRequired,
    );
    expect(required.accepts[0]?.amount).toBe("10000");
    await app.close();
  });

  it("signed payment → settle → 200 + PAYMENT-RESPONSE", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: {
        [HEADER_PAYMENT_SIGNATURE]: FIXTURE_SIGNATURE_HEADER,
      },
      payload: { message: "hi" },
    });
    expect(res.statusCode).toBe(200);
    const header = res.headers[HEADER_PAYMENT_RESPONSE.toLowerCase()];
    expect(typeof header).toBe("string");
    const settlement = decodeHeaderPayload(
      String(header),
      parseSettlementResponse,
    );
    expect(settlement.success).toBe(true);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    await app.close();
  });
});
