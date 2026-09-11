import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paymcpPaywall } from "../../src/middleware/paywall.js";
import { FacilitatorSettler } from "../../src/settler/facilitator.js";
import { SqliteLedger } from "../../src/ledger/sqlite.js";
import { buildPriceTable, parsePricesFile } from "../../src/pricing/resolve.js";
import { resolveAccessControls } from "../../src/controls/resolve.js";
import { HEADER_PAYMENT_SIGNATURE } from "../../src/headers/codec.js";
import {
  createFacilitatorFixtureFetch,
  FIXTURE_SIGNATURE_HEADER,
  FIXTURE_ACCEPT,
} from "../fixtures/facilitator.js";
import type { PaymcpEnvConfig } from "../../src/types/config.js";

const baseConfig: PaymcpEnvConfig = {
  facilitatorUrl: "https://facilitator.example/x402",
  payTo: FIXTURE_ACCEPT.payTo,
  network: FIXTURE_ACCEPT.network,
  asset: FIXTURE_ACCEPT.asset,
  assetName: "USDC",
};

describe("allowlist + per-tool budgets", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  async function buildApp(opts: {
    readonly allowlist?: readonly string[];
    readonly maxDailyAtomic?: string;
    readonly defaultMax?: string;
    readonly operationId?: string;
    readonly amount?: string;
    readonly extraOps?: { operationId: string; amount: string; maxDailyAtomic?: string }[];
  }) {
    const dir = mkdtempSync(join(tmpdir(), "paymcp-ctrl-"));
    dirs.push(dir);
    const opId = opts.operationId ?? "echoMessage";
    const amount = opts.amount ?? "10000";
    const ops = [
      {
        operationId: opId,
        amount,
        ...(opts.maxDailyAtomic !== undefined
          ? { maxDailyAtomic: opts.maxDailyAtomic }
          : {}),
      },
      ...(opts.extraOps ?? []),
    ];
    const pricesFile = parsePricesFile({
      version: 1,
      ...(opts.allowlist !== undefined ? { allowlist: opts.allowlist } : {}),
      operations: ops,
    });
    const prices = buildPriceTable([], pricesFile);
    const config: PaymcpEnvConfig = {
      ...baseConfig,
      ...(opts.defaultMax !== undefined
        ? { defaultMaxDailyAtomic: opts.defaultMax }
        : {}),
    };
    const accessControls = resolveAccessControls({
      config,
      pricesFile,
      ...(opts.allowlist !== undefined
        ? { explicitAllowlist: opts.allowlist }
        : {}),
    });

    const settleCounter = { calls: 0 };
    const baseFetch = createFacilitatorFixtureFetch({});
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/settle")) settleCounter.calls += 1;
      return baseFetch(input, init);
    };
    const settler = new FacilitatorSettler({
      baseUrl: config.facilitatorUrl,
      fetchImpl,
    });
    const settleSpy = vi.spyOn(settler, "settle");
    const ledger = new SqliteLedger(join(dir, "l.db"));
    const app = Fastify();

    await app.register(paymcpPaywall, {
      config,
      prices,
      settler,
      ledger,
      accessControls,
      publicBaseUrl: "http://127.0.0.1:8787",
      operationIdForRequest: (req) =>
        (req.routeOptions.config as { paymcpOperationId?: string })
          ?.paymcpOperationId ?? opId,
    });

    app.post(
      "/echo",
      { config: { paymcpOperationId: opId } },
      async () => ({ ok: true }),
    );
    for (const extra of opts.extraOps ?? []) {
      app.post(
        `/${extra.operationId}`,
        { config: { paymcpOperationId: extra.operationId } },
        async () => ({ ok: true }),
      );
    }

    return { app, settleSpy, settleCounter, ledger, opId };
  }

  it("operation not on allowlist → 403 denied", async () => {
    const { app, settleSpy } = await buildApp({
      allowlist: ["otherOp"],
      operationId: "echoMessage",
    });
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { [HEADER_PAYMENT_SIGNATURE]: FIXTURE_SIGNATURE_HEADER },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe("operation_not_allowlisted");
    expect(settleSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("under budget → settle on 200 works", async () => {
    const { app, settleSpy, settleCounter } = await buildApp({
      allowlist: ["echoMessage"],
      maxDailyAtomic: "50000",
    });
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { [HEADER_PAYMENT_SIGNATURE]: FIXTURE_SIGNATURE_HEADER },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(settleSpy).toHaveBeenCalledTimes(1);
    expect(settleCounter.calls).toBe(1);
    await app.close();
  });

  it("over daily budget → hard stop, settle not called", async () => {
    const { app, settleSpy, ledger } = await buildApp({
      allowlist: ["echoMessage"],
      maxDailyAtomic: "10000",
    });
    // Pre-fill ledger with settled spend that exhausts budget
    await ledger.recordSettlement({
      idempotencyKey: "prior-spend",
      operationId: "echoMessage",
      amount: "10000",
      network: FIXTURE_ACCEPT.network,
      payer: "0xabc",
      transaction: "0xdead",
      status: "settled",
    });
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { [HEADER_PAYMENT_SIGNATURE]: FIXTURE_SIGNATURE_HEADER },
      payload: {},
    });
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).error).toBe("budget_exceeded");
    expect(settleSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("different tools have independent budgets", async () => {
    const { app, settleSpy, ledger } = await buildApp({
      allowlist: ["echoMessage", "getWeather"],
      operationId: "echoMessage",
      amount: "10000",
      maxDailyAtomic: "10000",
      extraOps: [
        {
          operationId: "getWeather",
          amount: "10000",
          maxDailyAtomic: "50000",
        },
      ],
    });
    await ledger.recordSettlement({
      idempotencyKey: "echo-spent",
      operationId: "echoMessage",
      amount: "10000",
      network: FIXTURE_ACCEPT.network,
      payer: "0xabc",
      transaction: "0x1",
      status: "settled",
    });
    // echo over budget
    const echoRes = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { [HEADER_PAYMENT_SIGNATURE]: FIXTURE_SIGNATURE_HEADER },
      payload: {},
    });
    expect(echoRes.statusCode).toBe(429);
    // weather still under its own budget
    const weatherRes = await app.inject({
      method: "POST",
      url: "/getWeather",
      headers: { [HEADER_PAYMENT_SIGNATURE]: FIXTURE_SIGNATURE_HEADER },
      payload: {},
    });
    expect(weatherRes.statusCode).toBe(200);
    expect(settleSpy).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
