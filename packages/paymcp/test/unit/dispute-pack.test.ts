import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLedger } from "../../src/ledger/sqlite.js";
import {
  DISPUTE_PACK_POLICY_NOTE,
  DISPUTE_PACK_VERSION,
  exportDisputePack,
  verifyDisputePackSignature,
  hashDisputePackBody,
  type DisputePack,
} from "../../src/dispute/pack.js";
import { parseCli } from "../../src/cli/index.js";

const SECRET = "test-dispute-hmac-secret-32b!";

describe("exportDisputePack", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  async function seedLedger(): Promise<{
    ledger: SqliteLedger;
    from: string;
    to: string;
  }> {
    const dir = mkdtempSync(join(tmpdir(), "paymcp-dispute-"));
    dirs.push(dir);
    const ledger = new SqliteLedger(join(dir, "t.db"));

    await ledger.recordSettlement({
      idempotencyKey: "key-settled-a",
      operationId: "echoMessage",
      amount: "10000",
      network: "eip155:84532",
      payer: "0xabc0000000000000000000000000000000000001",
      transaction: "0xdeadbeef01",
      status: "settled",
    });
    await ledger.recordSettlement({
      idempotencyKey: "key-failed",
      operationId: "echoMessage",
      amount: "10000",
      network: "eip155:84532",
      payer: "",
      transaction: "",
      status: "failed",
      errorReason: "upstream_http_500",
    });
    await ledger.recordSettlement({
      idempotencyKey: "key-settled-b",
      operationId: "getWeather",
      amount: "25000",
      network: "eip155:84532",
      payer: "0xabc0000000000000000000000000000000000002",
      transaction: "0xdeadbeef02",
      status: "settled",
    });

    const settled = await ledger.listSettledInRange({
      fromIso: "1970-01-01T00:00:00.000Z",
      toIso: "2999-01-01T00:00:00.000Z",
    });
    expect(settled).toHaveLength(2);
    const created = settled.map((e) => e.createdAt).sort();
    return {
      ledger,
      from: created[0]!,
      to: created[created.length - 1]!,
    };
  }

  it("exports settled attempts only with policy note, hash, and verifiable HMAC", async () => {
    const { ledger, from, to } = await seedLedger();
    const pack = await exportDisputePack({
      ledger,
      from,
      to,
      hmacSecret: SECRET,
      exportedAt: "2026-09-12T00:00:00.000Z",
    });

    expect(pack.version).toBe(DISPUTE_PACK_VERSION);
    expect(pack.policyNote).toBe(DISPUTE_PACK_POLICY_NOTE);
    expect(pack.policyNote.toLowerCase()).toContain("payment-signature");
    expect(pack.attempts).toHaveLength(2);
    expect(pack.attempts.map((a) => a.operationId).sort()).toEqual([
      "echoMessage",
      "getWeather",
    ]);

    for (const attempt of pack.attempts) {
      expect(Object.keys(attempt).sort()).toEqual([
        "amount",
        "createdAt",
        "idempotencyKey",
        "network",
        "operationId",
        "payer",
        "transaction",
        "updatedAt",
      ]);
      expect(attempt).not.toHaveProperty("paymentSignature");
      expect(attempt).not.toHaveProperty("paymentPayload");
      expect(JSON.stringify(attempt)).not.toMatch(/PAYMENT-SIGNATURE/i);
    }

    const raw = JSON.stringify(pack);
    expect(raw).not.toMatch(/PAYMENT-SIGNATURE\s*[:=]/i);
    // No encoded PaymentPayload-sized blobs in the export.
    expect(raw).not.toMatch(/\b[A-Za-z0-9+/]{80,}={0,2}\b/);

    expect(pack.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(pack.signature.alg).toBe("HMAC-SHA256");
    expect(pack.signature.value).toMatch(/^[a-f0-9]{64}$/);

    expect(verifyDisputePackSignature(pack, SECRET)).toBe(true);
    expect(verifyDisputePackSignature(pack, "wrong-secret-xxxxxxxx")).toBe(
      false,
    );

    const tampered: DisputePack = {
      ...pack,
      attempts: [
        { ...pack.attempts[0]!, amount: "99999" },
        ...pack.attempts.slice(1),
      ],
    };
    expect(verifyDisputePackSignature(tampered, SECRET)).toBe(false);

    const recomputed = hashDisputePackBody({
      version: pack.version,
      policyNote: pack.policyNote,
      from: pack.from,
      to: pack.to,
      exportedAt: pack.exportedAt,
      attempts: pack.attempts,
    });
    expect(recomputed).toBe(pack.contentHash);

    await ledger.close();
  });

  it("excludes rows outside the time range", async () => {
    const { ledger, from } = await seedLedger();
    // from == to == first settled row only (inclusive bounds).
    const firstOnly = await exportDisputePack({
      ledger,
      from,
      to: from,
      hmacSecret: SECRET,
    });
    expect(firstOnly.attempts.length).toBeGreaterThanOrEqual(1);
    expect(firstOnly.attempts.every((a) => a.createdAt === from)).toBe(true);
    expect(verifyDisputePackSignature(firstOnly, SECRET)).toBe(true);
    await ledger.close();
  });

  it("rejects short HMAC secrets", async () => {
    const { ledger, from, to } = await seedLedger();
    await expect(
      exportDisputePack({
        ledger,
        from,
        to,
        hmacSecret: "short",
      }),
    ).rejects.toThrow(/PAYMCP_DISPUTE_HMAC_SECRET/);
    await ledger.close();
  });
});

describe("parseCli dispute-pack", () => {
  it("parses dispute-pack flags", () => {
    const parsed = parseCli([
      "dispute-pack",
      "--from",
      "2026-01-01T00:00:00.000Z",
      "--to",
      "2026-01-31T23:59:59.999Z",
      "--out",
      "pack.json",
      "--ledger",
      "./paymcp-ledger.db",
    ]);
    expect(parsed.kind).toBe("dispute-pack");
    if (parsed.kind !== "dispute-pack") return;
    expect(parsed.args.from).toBe("2026-01-01T00:00:00.000Z");
    expect(parsed.args.to).toBe("2026-01-31T23:59:59.999Z");
    expect(parsed.args.outPath).toBe("pack.json");
    expect(parsed.args.ledgerPath).toBe("./paymcp-ledger.db");
  });

  it("still parses compile mode", () => {
    const parsed = parseCli([
      "./openapi.yaml",
      "--out",
      "./paid-server",
      "--allow",
      "echoMessage",
    ]);
    expect(parsed.kind).toBe("compile");
    if (parsed.kind !== "compile") return;
    expect(parsed.args.openapiPath).toBe("./openapi.yaml");
    expect(parsed.args.allowlist).toEqual(["echoMessage"]);
  });
});

describe("listSettledInRange", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("returns only settled rows in range", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paymcp-dispute-range-"));
    dirs.push(dir);
    const ledger = new SqliteLedger(join(dir, "t.db"));
    await ledger.recordSettlement({
      idempotencyKey: "s1",
      operationId: "echoMessage",
      amount: "1",
      network: "eip155:84532",
      payer: "0x1",
      transaction: "0xa",
      status: "settled",
    });
    await ledger.recordSettlement({
      idempotencyKey: "f1",
      operationId: "echoMessage",
      amount: "1",
      network: "eip155:84532",
      payer: "",
      transaction: "",
      status: "failed",
    });
    const all = await ledger.listSettledInRange({
      fromIso: "1970-01-01T00:00:00.000Z",
      toIso: "2999-01-01T00:00:00.000Z",
    });
    expect(all).toHaveLength(1);
    expect(all[0]?.idempotencyKey).toBe("s1");
    await ledger.close();
  });
});
