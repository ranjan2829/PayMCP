#!/usr/bin/env node
/**
 * LIVE settlement smoke test — hits a REAL facilitator.
 *
 * Gated: requires PAYMCP_LIVE=1 and all PAYMCP_* env vars.
 * Optionally accepts PAYMENT_SIGNATURE_B64 (pre-signed) or uses
 * @x402/fetch if available with EVM_PRIVATE_KEY.
 *
 * This spends real (testnet or mainnet) funds. Use Base Sepolia first.
 *
 * Usage:
 *   PAYMCP_LIVE=1 \
 *   PAYMCP_FACILITATOR_URL=https://x402.org/facilitator \
 *   PAYMCP_PAY_TO=0x... \
 *   PAYMCP_NETWORK=eip155:84532 \
 *   PAYMCP_ASSET=0x036CbD53842c5426634e7929541eC2318f3dCF7e \
 *   PAYMENT_SIGNATURE_B64=... \
 *   DEMO_API_URL=http://127.0.0.1:8787 \
 *   node scripts/live-settle.mjs
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function requireLiveEnv() {
  if (process.env.PAYMCP_LIVE !== "1") {
    console.error(
      "Refusing to run: set PAYMCP_LIVE=1 to hit a real facilitator.\n" +
        "This script moves real (testnet/mainnet) funds. See README.",
    );
    process.exit(2);
  }
  const required = [
    "PAYMCP_FACILITATOR_URL",
    "PAYMCP_PAY_TO",
    "PAYMCP_NETWORK",
    "PAYMCP_ASSET",
  ];
  const missing = required.filter((k) => !process.env[k]?.trim());
  if (missing.length > 0) {
    console.error(`Missing env for live settle: ${missing.join(", ")}`);
    process.exit(2);
  }
}

async function main() {
  requireLiveEnv();

  const base = (process.env.DEMO_API_URL ?? "http://127.0.0.1:8787").replace(
    /\/$/,
    "",
  );
  const {
    HEADER_PAYMENT_REQUIRED,
    HEADER_PAYMENT_SIGNATURE,
    HEADER_PAYMENT_RESPONSE,
    decodeHeaderPayload,
    parsePaymentRequired,
    parseSettlementResponse,
  } = await import(join(root, "packages/paymcp/dist/index.js"));

  console.log(`LIVE settle against ${base} (facilitator=${process.env.PAYMCP_FACILITATOR_URL})`);
  console.log("WARNING: this path hits a real facilitator — funds may move.");

  const unpaid = await fetch(`${base}/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "live-hello" }),
  });
  console.log(`1) unpaid → HTTP ${unpaid.status}`);
  if (unpaid.status !== 402) {
    throw new Error(`expected 402, got ${unpaid.status}: ${await unpaid.text()}`);
  }
  const reqHeader = unpaid.headers.get(HEADER_PAYMENT_REQUIRED);
  if (!reqHeader) throw new Error("missing PAYMENT-REQUIRED");
  const required = decodeHeaderPayload(reqHeader, parsePaymentRequired);
  console.log(
    `   accepts amount=${required.accepts[0]?.amount} network=${required.accepts[0]?.network} payTo=${required.accepts[0]?.payTo}`,
  );

  let signature = process.env.PAYMENT_SIGNATURE_B64?.trim();
  if (!signature) {
    console.error(
      "\nNo PAYMENT_SIGNATURE_B64 set.\n" +
        "Sign a PaymentPayload matching the PAYMENT-REQUIRED accepts with the official\n" +
        "x402 client (@x402/fetch + @x402/evm ExactEvmScheme), then re-run with:\n" +
        "  PAYMENT_SIGNATURE_B64=<base64> PAYMCP_LIVE=1 node scripts/live-settle.mjs\n" +
        "See README «Wallet / payer» section.",
    );
    process.exit(3);
  }

  // Never print the full signature.
  console.log(`2) retry with PAYMENT-SIGNATURE (len=${signature.length}, redacted)`);

  const paid = await fetch(`${base}/echo`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [HEADER_PAYMENT_SIGNATURE]: signature,
    },
    body: JSON.stringify({ message: "live-hello" }),
  });
  console.log(`3) paid → HTTP ${paid.status}`);
  const respHeader = paid.headers.get(HEADER_PAYMENT_RESPONSE);
  const bodyText = await paid.text();
  if (respHeader) {
    const settlement = decodeHeaderPayload(respHeader, parseSettlementResponse);
    console.log(
      `   PAYMENT-RESPONSE success=${settlement.success} tx=${settlement.transaction?.slice(0, 18) ?? ""}… payer=${settlement.payer}`,
    );
  }
  console.log(`   body: ${bodyText.slice(0, 200)}`);
  if (paid.status !== 200) {
    process.exit(1);
  }
  console.log("live-settle ok");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
