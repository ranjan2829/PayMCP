import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLedger, deriveIdempotencyKey } from "../../src/ledger/sqlite.js";

describe("SqliteLedger", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("records settlement and replays idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paymcp-ledger-"));
    dirs.push(dir);
    const ledger = new SqliteLedger(join(dir, "t.db"));
    const key = deriveIdempotencyKey({
      operationId: "echoMessage",
      paymentSignatureHeader: "abc",
    });
    const first = await ledger.recordSettlement({
      idempotencyKey: key,
      operationId: "echoMessage",
      amount: "10000",
      network: "eip155:84532",
      payer: "0xabc",
      transaction: "0xdead",
      status: "settled",
    });
    expect(first.replayed).toBe(false);
    const second = await ledger.recordSettlement({
      idempotencyKey: key,
      operationId: "echoMessage",
      amount: "10000",
      network: "eip155:84532",
      payer: "0xabc",
      transaction: "0xdead",
      status: "settled",
    });
    expect(second.replayed).toBe(true);
    expect(second.entry.transaction).toBe("0xdead");
    expect(await ledger.countSettled()).toBe(1);
    expect(await ledger.isReady()).toBe(true);
    await ledger.close();
  });

  it("beginPending: only one concurrent claim wins; second is in_flight", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paymcp-ledger-"));
    dirs.push(dir);
    const ledger = new SqliteLedger(join(dir, "t.db"));
    const key = "concurrent-key-1";
    const input = {
      idempotencyKey: key,
      operationId: "echoMessage",
      amount: "10000",
      network: "eip155:84532",
    };

    const [a, b] = await Promise.all([
      ledger.beginPending(input),
      ledger.beginPending(input),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["claimed", "in_flight"]);
    expect(await ledger.findByIdempotencyKey(key)).toMatchObject({
      status: "pending",
    });
    await ledger.close();
  });

  it("beginPending: settled key returns already_settled; pending upgrades to settled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paymcp-ledger-"));
    dirs.push(dir);
    const ledger = new SqliteLedger(join(dir, "t.db"));
    const key = "settle-upgrade-1";
    const claim = await ledger.beginPending({
      idempotencyKey: key,
      operationId: "echoMessage",
      amount: "10000",
      network: "eip155:84532",
    });
    expect(claim.kind).toBe("claimed");

    const recorded = await ledger.recordSettlement({
      idempotencyKey: key,
      operationId: "echoMessage",
      amount: "10000",
      network: "eip155:84532",
      payer: "0xpayer",
      transaction: "0xtx",
      status: "settled",
    });
    expect(recorded.replayed).toBe(false);
    expect(recorded.entry.status).toBe("settled");

    const again = await ledger.beginPending({
      idempotencyKey: key,
      operationId: "echoMessage",
      amount: "10000",
      network: "eip155:84532",
    });
    expect(again.kind).toBe("already_settled");
    await ledger.close();
  });

  it("beginPending: failed key can be reclaimed for retry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paymcp-ledger-"));
    dirs.push(dir);
    const ledger = new SqliteLedger(join(dir, "t.db"));
    const key = "failed-reclaim-1";
    await ledger.recordSettlement({
      idempotencyKey: key,
      operationId: "echoMessage",
      amount: "10000",
      network: "eip155:84532",
      payer: "",
      transaction: "",
      status: "failed",
      errorReason: "upstream_http_500",
    });
    const reclaim = await ledger.beginPending({
      idempotencyKey: key,
      operationId: "echoMessage",
      amount: "10000",
      network: "eip155:84532",
    });
    expect(reclaim.kind).toBe("claimed");
    expect(reclaim.entry.status).toBe("pending");
    await ledger.close();
  });
});
