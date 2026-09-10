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
});
