import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paymcpPaywall } from "../../src/middleware/paywall.js";
import { FacilitatorSettler } from "../../src/settler/facilitator.js";
import { SqliteLedger } from "../../src/ledger/sqlite.js";
import { buildPriceTable, parsePricesFile } from "../../src/pricing/resolve.js";
import {
  HEADER_IDEMPOTENCY_KEY,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  decodeHeaderPayload,
} from "../../src/headers/codec.js";
import {
  parsePaymentRequired,
  parseSettlementResponse,
} from "../../src/headers/validate.js";
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

describe("paywall middleware (settle on 2xx only)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  async function buildApp(opts: {
    readonly handlerStatus?: number;
    readonly settleSpy?: { calls: number };
  } = {}) {
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

    const settleCounter = opts.settleSpy ?? { calls: 0 };
    const baseFetch = createFacilitatorFixtureFetch({});
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/settle")) {
        settleCounter.calls += 1;
      }
      return baseFetch(input, init);
    };

    const settler = new FacilitatorSettler({
      baseUrl: config.facilitatorUrl,
      fetchImpl,
    });
    const settleSpy = vi.spyOn(settler, "settle");
    const ledger = new SqliteLedger(join(dir, "l.db"));
    const handlerStatus = opts.handlerStatus ?? 200;

    await app.register(paymcpPaywall, {
      config,
      prices,
      settler,
      ledger,
      publicBaseUrl: "http://127.0.0.1:8787",
      operationIdForRequest: () => "echoMessage",
    });

    app.post("/echo", async (_req, reply) => {
      if (handlerStatus !== 200) {
        return reply.code(handlerStatus).send({ error: `status_${handlerStatus}` });
      }
      return { ok: true };
    });

    return { app, settler, settleSpy, settleCounter, ledger };
  }

  it("1) unpaid → 402 + PAYMENT-REQUIRED", async () => {
    const { app, settleSpy, settleCounter } = await buildApp();
    const res = await app.inject({ method: "POST", url: "/echo", payload: {} });
    expect(res.statusCode).toBe(402);
    const header = res.headers[HEADER_PAYMENT_REQUIRED.toLowerCase()];
    expect(typeof header).toBe("string");
    const required = decodeHeaderPayload(String(header), parsePaymentRequired);
    expect(required.accepts[0]?.amount).toBe("10000");
    expect(settleSpy).not.toHaveBeenCalled();
    expect(settleCounter.calls).toBe(0);
    await app.close();
  });

  it("2) valid payment + handler 200 → settle called once", async () => {
    const settleCounter = { calls: 0 };
    const { app, settleSpy } = await buildApp({
      handlerStatus: 200,
      settleSpy: settleCounter,
    });
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
    expect(settleSpy).toHaveBeenCalledTimes(1);
    expect(settleCounter.calls).toBe(1);
    await app.close();
  });

  it("3) valid payment + upstream/handler 500 → settle NOT called", async () => {
    const settleCounter = { calls: 0 };
    const { app, settleSpy, ledger } = await buildApp({
      handlerStatus: 500,
      settleSpy: settleCounter,
    });
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: {
        [HEADER_PAYMENT_SIGNATURE]: FIXTURE_SIGNATURE_HEADER,
      },
      payload: { message: "hi" },
    });
    expect(res.statusCode).toBe(500);
    expect(settleSpy).not.toHaveBeenCalled();
    expect(settleCounter.calls).toBe(0);
    expect(res.headers[HEADER_PAYMENT_RESPONSE.toLowerCase()]).toBeUndefined();
    expect(await ledger.countSettled()).toBe(0);
    await app.close();
  });

  it("4) valid payment + upstream/handler 400 → settle NOT called", async () => {
    const settleCounter = { calls: 0 };
    const { app, settleSpy, ledger } = await buildApp({
      handlerStatus: 400,
      settleSpy: settleCounter,
    });
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: {
        [HEADER_PAYMENT_SIGNATURE]: FIXTURE_SIGNATURE_HEADER,
      },
      payload: { message: "hi" },
    });
    expect(res.statusCode).toBe(400);
    expect(settleSpy).not.toHaveBeenCalled();
    expect(settleCounter.calls).toBe(0);
    expect(res.headers[HEADER_PAYMENT_RESPONSE.toLowerCase()]).toBeUndefined();
    expect(await ledger.countSettled()).toBe(0);
    await app.close();
  });

  it("two paid requests same Idempotency-Key after 200 → settle once", async () => {
    const settleCounter = { calls: 0 };
    const { app, settleSpy, ledger } = await buildApp({
      settleSpy: settleCounter,
    });
    const headers = {
      [HEADER_PAYMENT_SIGNATURE]: FIXTURE_SIGNATURE_HEADER,
      [HEADER_IDEMPOTENCY_KEY]: "idem-replay-1",
    };
    const first = await app.inject({
      method: "POST",
      url: "/echo",
      headers,
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    expect(settleSpy).toHaveBeenCalledTimes(1);
    expect(first.headers[HEADER_PAYMENT_RESPONSE.toLowerCase()]).toBeDefined();

    const second = await app.inject({
      method: "POST",
      url: "/echo",
      headers,
      payload: {},
    });
    expect(second.statusCode).toBe(200);
    expect(settleSpy).toHaveBeenCalledTimes(1);
    expect(settleCounter.calls).toBe(1);
    expect(await ledger.countSettled()).toBe(1);
    expect(second.headers[HEADER_PAYMENT_RESPONSE.toLowerCase()]).toBeDefined();
    await app.close();
  });

  it("concurrent/rapid double submit same key → still one settle", async () => {
    const settleCounter = { calls: 0 };
    const { app, settleSpy, ledger } = await buildApp({
      settleSpy: settleCounter,
    });
    const headers = {
      [HEADER_PAYMENT_SIGNATURE]: FIXTURE_SIGNATURE_HEADER,
      [HEADER_IDEMPOTENCY_KEY]: "idem-concurrent-1",
    };

    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: "/echo", headers, payload: {} }),
      app.inject({ method: "POST", url: "/echo", headers, payload: {} }),
    ]);

    const statuses = [a.statusCode, b.statusCode];
    // One request settles (200); the loser fail-closes with 409 in-flight,
    // or also 200 if it arrived after settle completed (replay).
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(settleSpy).toHaveBeenCalledTimes(1);
    expect(settleCounter.calls).toBe(1);
    expect(await ledger.countSettled()).toBe(1);

    const winner = a.statusCode === 200 ? a : b;
    expect(winner.headers[HEADER_PAYMENT_RESPONSE.toLowerCase()]).toBeDefined();

    if (a.statusCode === 409 || b.statusCode === 409) {
      const loser = a.statusCode === 409 ? a : b;
      expect(JSON.parse(loser.body).error).toBe("idempotency_in_flight");
    }
    await app.close();
  });

  it("different Idempotency-Keys → two settles", async () => {
    const settleCounter = { calls: 0 };
    const { app, settleSpy, ledger } = await buildApp({
      settleSpy: settleCounter,
    });
    const base = {
      [HEADER_PAYMENT_SIGNATURE]: FIXTURE_SIGNATURE_HEADER,
    };
    const first = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { ...base, [HEADER_IDEMPOTENCY_KEY]: "idem-a" },
      payload: {},
    });
    const second = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { ...base, [HEADER_IDEMPOTENCY_KEY]: "idem-b" },
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(settleSpy).toHaveBeenCalledTimes(2);
    expect(settleCounter.calls).toBe(2);
    expect(await ledger.countSettled()).toBe(2);
    await app.close();
  });
});
