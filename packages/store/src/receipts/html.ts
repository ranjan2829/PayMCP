import type { PublicReceipt } from "./types.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatUsdc(atomic: string): string {
  try {
    const n = BigInt(atomic);
    const whole = n / 1_000_000n;
    const frac = n % 1_000_000n;
    const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
    return fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
  } catch {
    return atomic;
  }
}

/**
 * Minimal production-dark receipt page (void black + lime accent).
 * Keep short — screenshot-friendly for X posts.
 */
export function renderReceiptHtml(receipt: PublicReceipt): string {
  const amount = formatUsdc(receipt.amount);
  const explorer =
    receipt.explorerUrl !== null
      ? `<a class="link" href="${esc(receipt.explorerUrl)}" rel="noopener noreferrer" target="_blank">View on explorer →</a>`
      : `<span class="muted">No on-chain tx yet</span>`;
  const settleClass =
    receipt.settleStatus === "settled"
      ? "ok"
      : receipt.settleStatus === "failed"
        ? "bad"
        : "warn";
  const payoutClass =
    receipt.payoutStatus === "paid"
      ? "ok"
      : receipt.payoutStatus === "failed"
        ? "bad"
        : "warn";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>PayMCP receipt · ${esc(receipt.spendId.slice(0, 8))}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #000; color: #e8e8e8;
    display: flex; align-items: center; justify-content: center;
    padding: 2rem 1rem;
  }
  .card {
    width: 100%; max-width: 420px;
    border: 1px solid #1a1a1a; border-radius: 12px;
    padding: 1.5rem; background: #0a0a0a;
  }
  .brand { color: #b8ff3c; font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 1rem; }
  h1 { font-size: 1.1rem; font-weight: 600; margin: 0 0 0.25rem; }
  .amount { font-size: 1.75rem; color: #b8ff3c; margin: 1rem 0 1.25rem; }
  .row { display: flex; justify-content: space-between; gap: 1rem; padding: 0.4rem 0; border-top: 1px solid #141414; font-size: 0.8rem; }
  .label { color: #666; }
  .val { text-align: right; word-break: break-all; }
  .ok { color: #b8ff3c; }
  .bad { color: #ff6b6b; }
  .warn { color: #ffcc66; }
  .muted { color: #555; font-size: 0.8rem; }
  .link { color: #b8ff3c; text-decoration: none; font-size: 0.8rem; }
  .link:hover { text-decoration: underline; }
  .foot { margin-top: 1.25rem; font-size: 0.7rem; color: #444; }
</style>
</head>
<body>
<main class="card">
  <div class="brand">PayMCP · receipt</div>
  <h1>${esc(receipt.listing.name)}</h1>
  <div class="muted">${esc(receipt.networkLabel)}</div>
  <div class="amount">${esc(amount)} ${esc(receipt.asset)}</div>
  <div class="row"><span class="label">settle</span><span class="val ${settleClass}">${esc(receipt.settleStatus)}</span></div>
  <div class="row"><span class="label">payout</span><span class="val ${payoutClass}">${esc(receipt.payoutStatus)}</span></div>
  <div class="row"><span class="label">buyer</span><span class="val">${esc(receipt.buyer)}</span></div>
  <div class="row"><span class="label">listing</span><span class="val">${esc(receipt.listing.id)}</span></div>
  <div class="row"><span class="label">spend</span><span class="val">${esc(receipt.spendId)}</span></div>
  ${
    receipt.payoutTx !== null
      ? `<div class="row"><span class="label">tx</span><span class="val">${esc(receipt.payoutTx.slice(0, 10))}…${esc(receipt.payoutTx.slice(-6))}</span></div>`
      : ""
  }
  <div class="row"><span class="label">explorer</span><span class="val">${explorer}</span></div>
  <div class="foot">agent paid · settle-on-2xx · ${esc(receipt.settledAt ?? receipt.createdAt)}</div>
</main>
</body>
</html>`;
}
