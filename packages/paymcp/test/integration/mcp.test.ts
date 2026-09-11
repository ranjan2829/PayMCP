import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPaidMcpServer } from "../../src/mcp/server.js";
import { FacilitatorSettler } from "../../src/settler/facilitator.js";
import { SqliteLedger } from "../../src/ledger/sqlite.js";
import { buildPriceTable, parsePricesFile } from "../../src/pricing/resolve.js";
import {
  createFacilitatorFixtureFetch,
  FIXTURE_SIGNATURE_HEADER,
  FIXTURE_ACCEPT,
} from "../fixtures/facilitator.js";
import type { PaymcpEnvConfig } from "../../src/types/config.js";
import type { CompiledOperation } from "../../src/types/openapi.js";

const config: PaymcpEnvConfig = {
  facilitatorUrl: "https://facilitator.example/x402",
  payTo: FIXTURE_ACCEPT.payTo,
  network: FIXTURE_ACCEPT.network,
  asset: FIXTURE_ACCEPT.asset,
  assetName: "USDC",
};

const echoOp: CompiledOperation = {
  operationId: "echoMessage",
  method: "post",
  path: "/echo",
  summary: "Echo",
  description: "Echo one JSON payload",
  parameters: [],
  requestBody: undefined,
  amount: "10000",
  paid: true,
};

describe("MCP paid tools (settle on upstream 2xx only)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  async function buildHarness(opts: {
    readonly upstreamStatus?: number;
  } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "paymcp-mcp-"));
    dirs.push(dir);
    const prices = buildPriceTable(
      [],
      parsePricesFile({
        version: 1,
        operations: [{ operationId: "echoMessage", amount: "10000" }],
      }),
    );

    const settleCounter = { calls: 0 };
    const baseFetch = createFacilitatorFixtureFetch({});
    const upstreamStatus = opts.upstreamStatus ?? 200;

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/settle")) {
        settleCounter.calls += 1;
        return baseFetch(input, init);
      }
      if (url.endsWith("/verify")) {
        return baseFetch(input, init);
      }
      // Upstream API
      if (upstreamStatus !== 200) {
        return new Response(
          JSON.stringify({ error: `status_${upstreamStatus}` }),
          {
            status: upstreamStatus,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const settler = new FacilitatorSettler({
      baseUrl: config.facilitatorUrl,
      fetchImpl,
    });
    const settleSpy = vi.spyOn(settler, "settle");
    const ledger = new SqliteLedger(join(dir, "l.db"));

    const server = await createPaidMcpServer({
      config,
      operations: [echoOp],
      prices,
      upstreamBaseUrl: "http://127.0.0.1:8787",
      settler,
      ledger,
      fetchImpl,
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);

    return {
      client,
      server,
      settleSpy,
      settleCounter,
      ledger,
      async close() {
        await client.close();
        await server.close();
        await ledger.close();
      },
    };
  }

  function toolText(result: {
    content: Array<{ type: string; text?: string }>;
  }): string {
    const part = result.content.find((c) => c.type === "text");
    return part?.text ?? "";
  }

  it("1) unpaid → 402 challenge", async () => {
    const h = await buildHarness();
    const result = await h.client.callTool({
      name: "echoMessage",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse(toolText(result as never));
    expect(body.error).toBe("payment_required");
    expect(body.status).toBe(402);
    expect(h.settleSpy).not.toHaveBeenCalled();
    expect(h.settleCounter.calls).toBe(0);
    await h.close();
  });

  it("2) valid payment + upstream 200 → settle called once", async () => {
    const h = await buildHarness({ upstreamStatus: 200 });
    const result = await h.client.callTool({
      name: "echoMessage",
      arguments: {
        paymentSignature: FIXTURE_SIGNATURE_HEADER,
        body: { message: "hi" },
      },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(toolText(result as never));
    expect(body.status).toBe(200);
    expect(body.settlement?.success).toBe(true);
    expect(body.data).toEqual({ ok: true });
    expect(h.settleSpy).toHaveBeenCalledTimes(1);
    expect(h.settleCounter.calls).toBe(1);
    await h.close();
  });

  it("3) valid payment + upstream 500 → settle NOT called", async () => {
    const h = await buildHarness({ upstreamStatus: 500 });
    const result = await h.client.callTool({
      name: "echoMessage",
      arguments: {
        paymentSignature: FIXTURE_SIGNATURE_HEADER,
        body: { message: "hi" },
      },
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse(toolText(result as never));
    expect(body.error).toBe("upstream_failed");
    expect(body.status).toBe(500);
    expect(body.settlement).toBeNull();
    expect(h.settleSpy).not.toHaveBeenCalled();
    expect(h.settleCounter.calls).toBe(0);
    expect(await h.ledger.countSettled()).toBe(0);
    await h.close();
  });

  it("4) valid payment + upstream 400 → settle NOT called", async () => {
    const h = await buildHarness({ upstreamStatus: 400 });
    const result = await h.client.callTool({
      name: "echoMessage",
      arguments: {
        paymentSignature: FIXTURE_SIGNATURE_HEADER,
        body: { message: "hi" },
      },
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse(toolText(result as never));
    expect(body.error).toBe("upstream_failed");
    expect(body.status).toBe(400);
    expect(h.settleSpy).not.toHaveBeenCalled();
    expect(h.settleCounter.calls).toBe(0);
    expect(await h.ledger.countSettled()).toBe(0);
    await h.close();
  });

  it("two paid tool calls same idempotencyKey after 200 → settle once", async () => {
    const h = await buildHarness({ upstreamStatus: 200 });
    const args = {
      paymentSignature: FIXTURE_SIGNATURE_HEADER,
      idempotencyKey: "mcp-idem-replay-1",
      body: { message: "hi" },
    };
    const first = await h.client.callTool({ name: "echoMessage", arguments: args });
    expect(first.isError).toBeFalsy();
    expect(h.settleSpy).toHaveBeenCalledTimes(1);

    const second = await h.client.callTool({ name: "echoMessage", arguments: args });
    expect(second.isError).toBeFalsy();
    const body = JSON.parse(toolText(second as never));
    expect(body.settlement?.success).toBe(true);
    expect(h.settleSpy).toHaveBeenCalledTimes(1);
    expect(h.settleCounter.calls).toBe(1);
    expect(await h.ledger.countSettled()).toBe(1);
    await h.close();
  });

  it("concurrent tool calls same idempotencyKey → still one settle", async () => {
    const h = await buildHarness({ upstreamStatus: 200 });
    const args = {
      paymentSignature: FIXTURE_SIGNATURE_HEADER,
      idempotencyKey: "mcp-idem-concurrent-1",
      body: { message: "hi" },
    };
    const [a, b] = await Promise.all([
      h.client.callTool({ name: "echoMessage", arguments: args }),
      h.client.callTool({ name: "echoMessage", arguments: args }),
    ]);

    expect(h.settleSpy).toHaveBeenCalledTimes(1);
    expect(h.settleCounter.calls).toBe(1);
    expect(await h.ledger.countSettled()).toBe(1);

    const texts = [toolText(a as never), toolText(b as never)];
    const parsed = texts.map((t) => {
      try {
        return JSON.parse(t) as { error?: string; settlement?: { success?: boolean } };
      } catch {
        return { error: t };
      }
    });
    const successes = parsed.filter((p) => p.settlement?.success === true);
    const inFlight = parsed.filter((p) => p.error === "idempotency_in_flight");
    expect(successes.length + inFlight.length).toBe(2);
    expect(successes.length).toBeGreaterThanOrEqual(1);
    await h.close();
  });

  it("different idempotencyKeys → two settles", async () => {
    const h = await buildHarness({ upstreamStatus: 200 });
    const first = await h.client.callTool({
      name: "echoMessage",
      arguments: {
        paymentSignature: FIXTURE_SIGNATURE_HEADER,
        idempotencyKey: "mcp-key-a",
        body: {},
      },
    });
    const second = await h.client.callTool({
      name: "echoMessage",
      arguments: {
        paymentSignature: FIXTURE_SIGNATURE_HEADER,
        idempotencyKey: "mcp-key-b",
        body: {},
      },
    });
    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect(h.settleSpy).toHaveBeenCalledTimes(2);
    expect(h.settleCounter.calls).toBe(2);
    expect(await h.ledger.countSettled()).toBe(2);
    await h.close();
  });
});
