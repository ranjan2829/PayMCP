#!/usr/bin/env node
/**
 * End-to-end demo against demo-api with a fixture facilitator fetch injected
 * into the in-process server. Proves unpaid→402→signed→200 using the real
 * FacilitatorSettler client + real header codec (not a product fake/mock settlement mode).
 *
 * For live facilitator demos, set PAYMCP_* and run examples/demo-api with a
 * real wallet-signed PAYMENT-SIGNATURE (see README).
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const require = createRequire(import.meta.url);

// Ensure workspace build artifacts exist
async function main() {
  console.log("=== PROTOCOL FIXTURE DEMO (not live money) ===");
  console.log("Uses FacilitatorSettler against a recorded /verify+/settle fixture.");
  console.log("For real funds: PAYMCP_LIVE=1 node scripts/live-settle.mjs (see README).");

  const { buildDemoServer } = await import(
    join(root, "examples/demo-api/dist/server.js")
  ).catch(async () => {
    // fall back to tsx register path via dynamic paymcp from dist
    throw new Error(
      "demo-api not built — run: pnpm --filter @paymcp/demo-api build",
    );
  });

  const {
    FacilitatorSettler,
    HEADER_PAYMENT_REQUIRED,
    HEADER_PAYMENT_SIGNATURE,
    HEADER_PAYMENT_RESPONSE,
    encodeHeaderPayload,
    decodeHeaderPayload,
    parsePaymentRequired,
    parseSettlementResponse,
    X402_VERSION,
  } = await import(join(root, "packages/paymcp/dist/index.js"));

  const accept = {
    scheme: "exact",
    network: "eip155:84532",
    amount: "10000",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  };

  const fixtureFetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/verify")) {
      return new Response(
        JSON.stringify({
          isValid: true,
          payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/settle")) {
      return new Response(
        JSON.stringify({
          success: true,
          transaction:
            "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
          network: accept.network,
          payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 404 });
  };

  const dir = mkdtempSync(join(tmpdir(), "paymcp-demo-"));
  const settler = new FacilitatorSettler({
    baseUrl: "https://facilitator.example/x402",
    fetchImpl: fixtureFetch,
  });

  const config = {
    facilitatorUrl: "https://facilitator.example/x402",
    payTo: accept.payTo,
    network: accept.network,
    asset: accept.asset,
    assetName: "USDC",
    ledgerPath: join(dir, "ledger.db"),
  };

  const app = await buildDemoServer({
    port: 0,
    config,
    settler,
    ledgerPath: join(dir, "ledger.db"),
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const unpaid = await fetch(`${base}/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  });
  console.log(`1) unpaid POST /echo → HTTP ${unpaid.status}`);
  if (unpaid.status !== 402) {
    throw new Error(`expected 402, got ${unpaid.status}`);
  }
  const reqHeader = unpaid.headers.get(HEADER_PAYMENT_REQUIRED);
  if (!reqHeader) {
    throw new Error("missing PAYMENT-REQUIRED");
  }
  const required = decodeHeaderPayload(reqHeader, parsePaymentRequired);
  console.log(
    `   PAYMENT-REQUIRED accepts amount=${required.accepts[0]?.amount} network=${required.accepts[0]?.network}`,
  );

  const payload = {
    x402Version: X402_VERSION,
    resource: required.resource,
    accepted: required.accepts[0],
    payload: {
      signature: "0xdemo",
      authorization: {
        from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        to: accept.payTo,
        value: accept.amount,
        validAfter: "1740672089",
        validBefore: "1740672154",
        nonce: "0xabc",
      },
    },
  };
  const sig = encodeHeaderPayload(payload);

  const paid = await fetch(`${base}/echo`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [HEADER_PAYMENT_SIGNATURE]: sig,
    },
    body: JSON.stringify({ message: "hello" }),
  });
  console.log(`2) paid POST /echo → HTTP ${paid.status}`);
  if (paid.status !== 200) {
    throw new Error(`expected 200, got ${paid.status}: ${await paid.text()}`);
  }
  const respHeader = paid.headers.get(HEADER_PAYMENT_RESPONSE);
  if (!respHeader) {
    throw new Error("missing PAYMENT-RESPONSE");
  }
  const settlement = decodeHeaderPayload(respHeader, parseSettlementResponse);
  const body = await paid.json();
  console.log(`   PAYMENT-RESPONSE success=${settlement.success} tx=${settlement.transaction.slice(0, 18)}…`);
  console.log(`   body: ${JSON.stringify(body)}`);
  console.log(
    `metric: round_trip_settlement_headers=3 (REQUIRED→SIGNATURE→RESPONSE); unpaid_status=402; paid_status=200`,
  );

  await app.close();
  rmSync(dir, { recursive: true, force: true });
  console.log("demo ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
