import { describe, expect, it } from "vitest";
import { openStoreDb } from "../src/db.js";
import { BuyerBalanceLedger } from "../src/ledger/balance.js";
import { StoreError } from "../src/errors/index.js";

describe("BuyerBalanceLedger", () => {
  it("tops up and reports balance", () => {
    const db = openStoreDb(":memory:");
    const ledger = new BuyerBalanceLedger(db);
    expect(ledger.getBalance("buyer_a").balance).toBe("0");
    const bal = ledger.topUp({ buyerId: "buyer_a", amount: "50000" });
    expect(bal.balance).toBe("50000");
    ledger.topUp({ buyerId: "buyer_a", amount: "10000" });
    expect(ledger.getBalance("buyer_a").balance).toBe("60000");
    db.close();
  });

  it("holds on beginSpend and settles debit", () => {
    const db = openStoreDb(":memory:");
    const ledger = new BuyerBalanceLedger(db);
    ledger.topUp({ buyerId: "b1", amount: "100000" });
    const begin = ledger.beginSpend({
      buyerId: "b1",
      listingId: "lst_x",
      amount: "25000",
      idempotencyKey: "idem-1",
      requestId: "req-1",
    });
    expect(begin.kind).toBe("claimed");
    expect(ledger.getBalance("b1").balance).toBe("75000");
    const settled = ledger.completeSpend({
      idempotencyKey: "idem-1",
      status: "settled",
      upstreamStatus: 200,
    });
    expect(settled.status).toBe("settled");
    expect(ledger.getBalance("b1").balance).toBe("75000");
    const log = ledger.listSpendLog({ buyerId: "b1" });
    expect(log.total).toBe(1);
    expect(log.entries[0]?.idempotencyKey).toBe("idem-1");
    expect(log.entries[0]?.requestId).toBe("req-1");
    db.close();
  });

  it("refunds hold when completeSpend fails", () => {
    const db = openStoreDb(":memory:");
    const ledger = new BuyerBalanceLedger(db);
    ledger.topUp({ buyerId: "b1", amount: "10000" });
    ledger.beginSpend({
      buyerId: "b1",
      listingId: "lst_x",
      amount: "10000",
      idempotencyKey: "idem-fail",
    });
    expect(ledger.getBalance("b1").balance).toBe("0");
    ledger.completeSpend({
      idempotencyKey: "idem-fail",
      status: "failed",
      upstreamStatus: 500,
      errorReason: "upstream 500",
    });
    expect(ledger.getBalance("b1").balance).toBe("10000");
    db.close();
  });

  it("rejects insufficient balance with 402", () => {
    const db = openStoreDb(":memory:");
    const ledger = new BuyerBalanceLedger(db);
    ledger.topUp({ buyerId: "b1", amount: "100" });
    expect(() =>
      ledger.beginSpend({
        buyerId: "b1",
        listingId: "lst_x",
        amount: "101",
        idempotencyKey: "idem-poor",
      }),
    ).toThrow(StoreError);
    try {
      ledger.beginSpend({
        buyerId: "b1",
        listingId: "lst_x",
        amount: "101",
        idempotencyKey: "idem-poor-2",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(StoreError);
      expect((err as StoreError).code).toBe("INSUFFICIENT_BALANCE");
      expect((err as StoreError).statusCode).toBe(402);
    }
    db.close();
  });

  it("replays already_settled idempotency keys", () => {
    const db = openStoreDb(":memory:");
    const ledger = new BuyerBalanceLedger(db);
    ledger.topUp({ buyerId: "b1", amount: "50000" });
    ledger.beginSpend({
      buyerId: "b1",
      listingId: "lst_x",
      amount: "10000",
      idempotencyKey: "idem-replay",
    });
    ledger.completeSpend({
      idempotencyKey: "idem-replay",
      status: "settled",
      upstreamStatus: 200,
    });
    const again = ledger.beginSpend({
      buyerId: "b1",
      listingId: "lst_x",
      amount: "10000",
      idempotencyKey: "idem-replay",
    });
    expect(again.kind).toBe("already_settled");
    expect(ledger.getBalance("b1").balance).toBe("40000");
    db.close();
  });

  it("fail-closes in_flight pending keys", () => {
    const db = openStoreDb(":memory:");
    const ledger = new BuyerBalanceLedger(db);
    ledger.topUp({ buyerId: "b1", amount: "50000" });
    ledger.beginSpend({
      buyerId: "b1",
      listingId: "lst_x",
      amount: "10000",
      idempotencyKey: "idem-inflight",
    });
    const second = ledger.beginSpend({
      buyerId: "b1",
      listingId: "lst_x",
      amount: "10000",
      idempotencyKey: "idem-inflight",
    });
    expect(second.kind).toBe("in_flight");
    db.close();
  });
});
