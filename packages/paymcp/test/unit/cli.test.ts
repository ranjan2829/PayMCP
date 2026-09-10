import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../../src/cli/index.js";
import { generatePaidServer } from "../../src/compiler/generate.js";

describe("CLI parseArgs", () => {
  it("parses out and allow", () => {
    const args = parseArgs([
      "./openapi.yaml",
      "--out",
      "./paid-server",
      "--allow",
      "echoMessage,getWeather",
    ]);
    expect(args.openapiPath).toBe("./openapi.yaml");
    expect(args.outDir).toBe("./paid-server");
    expect(args.allowlist).toEqual(["echoMessage", "getWeather"]);
  });
});

describe("generatePaidServer", () => {
  it("writes runnable package", () => {
    const dir = mkdtempSync(join(tmpdir(), "paymcp-gen-"));
    const openapi = join(dir, "openapi.yaml");
    writeFileSync(
      openapi,
      `openapi: 3.0.3
info:
  title: t
  version: "1"
paths:
  /echo:
    post:
      operationId: echoMessage
      x-paymcp:
        amount: "10000"
`,
    );
    const out = join(dir, "paid-server");
    generatePaidServer({ openapiPath: openapi, outDir: out });
    expect(existsSync(join(out, "src/server.js"))).toBe(true);
    expect(existsSync(join(out, ".env.example"))).toBe(true);
    const env = readFileSync(join(out, ".env.example"), "utf8");
    expect(env).toContain("PAYMCP_FACILITATOR_URL");
    rmSync(dir, { recursive: true, force: true });
  });
});
