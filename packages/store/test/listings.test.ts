import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStoreDb } from "../src/db.js";
import { ListingRegistry } from "../src/listings/registry.js";
import { StoreError } from "../src/errors/index.js";

const dirs: string[] = [];

function tempDb(): ReturnType<typeof openStoreDb> {
  const dir = mkdtempSync(join(tmpdir(), "paymcp-store-"));
  dirs.push(dir);
  return openStoreDb(join(dir, "test.db"));
}

afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) {
      rmSync(d, { recursive: true, force: true });
    }
  }
});

describe("ListingRegistry", () => {
  it("creates and fetches a listing", () => {
    const db = openStoreDb(":memory:");
    const reg = new ListingRegistry(db);
    const listing = reg.create({
      name: "Echo",
      description: "test",
      openapi: {
        openapi: "3.0.3",
        info: { title: "t", version: "1" },
        paths: {},
      },
      price: "10000",
      sellerId: "seller_1",
      payTo: "0x1111111111111111111111111111111111111111",
      network: "eip155:84532",
      upstreamBaseUrl: "http://127.0.0.1:8787",
      defaultPath: "/echo",
      defaultMethod: "POST",
    });
    expect(listing.id).toMatch(/^lst_/);
    expect(listing.price).toBe("10000");
    expect(reg.getOrThrow(listing.id).name).toBe("Echo");
    db.close();
  });

  it("lists active catalog and updates status", () => {
    const db = openStoreDb(":memory:");
    const reg = new ListingRegistry(db);
    const a = reg.create({
      id: "lst_a",
      name: "A",
      openapi: { openapi: "3.0.3", info: { title: "t", version: "1" }, paths: {} },
      price: "1",
      sellerId: "s",
      payTo: "0x1111111111111111111111111111111111111111",
      network: "eip155:84532",
    });
    reg.create({
      id: "lst_b",
      name: "B",
      openapi: { openapi: "3.0.3", info: { title: "t", version: "1" }, paths: {} },
      price: "2",
      sellerId: "s",
      payTo: "0x1111111111111111111111111111111111111111",
      network: "eip155:84532",
      status: "paused",
    });
    expect(reg.list({ status: "active" }).total).toBe(1);
    reg.setStatus(a.id, "archived");
    expect(reg.list({ status: "active" }).total).toBe(0);
    db.close();
  });

  it("throws on missing listing", () => {
    const db = openStoreDb(":memory:");
    const reg = new ListingRegistry(db);
    expect(() => reg.getOrThrow("missing")).toThrow(StoreError);
    db.close();
  });
});
