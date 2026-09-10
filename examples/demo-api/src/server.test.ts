import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDemoServer } from "./server.js";

describe("demo-api free health (paywall skipped)", () => {
  it("returns ok", async () => {
    const app = await buildDemoServer({ skipPaywall: true });
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    await app.close();
  });
});
