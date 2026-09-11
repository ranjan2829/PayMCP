#!/usr/bin/env node
/**
 * EXAMPLE: pay a PayMCP 402-gated HTTP endpoint with the official x402 client.
 *
 * Flow (x402 V2, not a new protocol):
 *   1. POST/GET the paid route (no PAYMENT-SIGNATURE) → 402 + PAYMENT-REQUIRED
 *   2. @x402/fetch signs an ExactEvmScheme payload and retries with PAYMENT-SIGNATURE
 *   3. PayMCP verifies via its facilitator, runs the handler, settles on 2xx,
 *      returns 200 + PAYMENT-RESPONSE
 *
 * The buyer does not call the facilitator. PayMCP does POST /verify + /settle.
 *
 * Live pay (spends USDC):
 *   PAYMCP_LIVE=1 EVM_PRIVATE_KEY=0x... pnpm buyer:example
 *
 * Probe only (no funds):
 *   pnpm buyer:probe
 */
import {
  buildTargetUrl,
  BuyerEnvError,
  normalizePath,
  parseBuyerConfig,
  redactPrivateKey,
} from "./env.js";
import {
  createPaidFetch,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  summarizePaymentRequiredHeader,
  summarizeSettlementHeader,
} from "./client.js";

const probe = process.argv.includes("--probe");

async function runProbe(): Promise<void> {
  const baseUrl = (
    process.env["DEMO_API_URL"] ??
    process.env["PAYMCP_BUYER_URL"] ??
    "http://127.0.0.1:8787"
  ).replace(/\/+$/, "");
  const path = normalizePath(process.env["PAYMCP_BUYER_PATH"] ?? "/echo");
  const url = buildTargetUrl(baseUrl, path);
  const method = path.startsWith("/weather") ? "GET" : "POST";
  const target =
    method === "GET" && path.startsWith("/weather")
      ? `${url}${url.includes("?") ? "&" : "?"}city=dubai`
      : url;

  console.log("=== PayMCP buyer probe (no payment, no funds) ===");
  console.log(`GET/POST unpaid ${method} ${target}`);
  console.log(
    "Facilitator URL is server-side (PAYMCP_FACILITATOR_URL); this client does not call it.",
  );

  const init: RequestInit = { method };
  if (method === "POST") {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify({ message: "probe" });
  }

  const res = await fetch(target, init);
  const bodyText = await res.text();
  console.log(`HTTP ${res.status}`);
  const required = res.headers.get(HEADER_PAYMENT_REQUIRED);
  const summary = summarizePaymentRequiredHeader(required);
  if (summary !== undefined) {
    console.log("PAYMENT-REQUIRED (decoded, no secrets):");
    console.log(`  x402Version=${summary.x402Version ?? "?"}`);
    console.log(`  scheme=${summary.scheme ?? "?"} amount=${summary.amount ?? "?"}`);
    console.log(`  network=${summary.network ?? "?"} asset=${summary.asset ?? "?"}`);
    console.log(`  payTo=${summary.payTo ?? "?"}`);
    console.log(`  resource=${summary.resourceUrl ?? "?"}`);
  } else {
    console.log("No PAYMENT-REQUIRED header.");
  }
  console.log(`body: ${bodyText.slice(0, 240)}`);
  if (res.status !== 402) {
    throw new Error(
      `expected HTTP 402 from a paid PayMCP route, got ${res.status}`,
    );
  }
  console.log("probe ok — start the paid path with PAYMCP_LIVE=1 pnpm buyer:example");
}

async function runPaid(): Promise<void> {
  const config = parseBuyerConfig(process.env);
  const url = buildTargetUrl(config.baseUrl, config.path);
  const target =
    config.method === "GET" && config.path.startsWith("/weather")
      ? `${url}${url.includes("?") ? "&" : "?"}city=dubai`
      : url;

  console.log("=== PayMCP buyer example (@x402/fetch) ===");
  console.log("WARNING: this spends real (testnet/mainnet) USDC via PayMCP's facilitator.");
  console.log(`target: ${config.method} ${target}`);
  console.log(`payer key: ${redactPrivateKey(config.privateKey)}`);
  console.log(`scheme network: ${config.networkPattern}`);
  console.log(
    `facilitator (server-side, not called by this client): ${config.facilitatorUrl ?? "(unset — set on the PayMCP server)"}`,
  );

  const fetchWithPayment = createPaidFetch({
    privateKey: config.privateKey,
    networkPattern: "eip155:*",
    maxAmountPerPayment: config.maxAmountPerPayment,
  });

  const headers: Record<string, string> = {};
  if (config.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const res = await fetchWithPayment(target, {
    method: config.method,
    headers,
    ...(config.body !== undefined ? { body: config.body } : {}),
  });

  const settlement = summarizeSettlementHeader(
    res.headers.get(HEADER_PAYMENT_RESPONSE),
  );
  const bodyText = await res.text();
  console.log(`paid HTTP ${res.status}`);
  if (settlement.present) {
    console.log(
      `PAYMENT-RESPONSE success=${settlement.success ?? "?"} network=${settlement.network ?? "?"} payer=${settlement.payer ?? "?"} tx=${settlement.transactionPrefix ?? "n/a"}`,
    );
    if (settlement.errorReason !== undefined) {
      console.log(`  errorReason=${settlement.errorReason}`);
    }
  } else {
    console.log("No PAYMENT-RESPONSE header (server did not settle).");
  }
  console.log(`body: ${bodyText.slice(0, 300)}`);
  if (res.status !== 200) {
    process.exit(1);
  }
  console.log("buyer example ok");
}

async function main(): Promise<void> {
  if (probe) {
    await runProbe();
    return;
  }
  await runPaid();
}

main().catch((err: unknown) => {
  if (err instanceof BuyerEnvError) {
    console.error(err.message);
    process.exit(2);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
