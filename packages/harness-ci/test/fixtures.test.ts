import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFixtureSuite, evaluateAgentTrace, loadTraceFile } from "../src/evaluate.js";
import { AgentTraceSchema } from "../src/schema.js";

const fixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

describe("fixture suite", () => {
  it("good fixtures pass and bad fixtures fail", async () => {
    const { exitCode, results, summary } = await runFixtureSuite(fixturesRoot);
    expect(summary).toMatch(/PASS/);
    expect(exitCode).toBe(0);
    expect(results.length).toBeGreaterThanOrEqual(8);
    for (const r of results) {
      expect(r.matchedExpectation, formatMismatch(r)).toBe(true);
    }
  });

  it("each fixture JSON validates against AgentTraceSchema", async () => {
    const { results } = await runFixtureSuite(fixturesRoot);
    for (const r of results) {
      const raw = await loadTraceFile(r.file);
      expect(() => AgentTraceSchema.parse(raw)).not.toThrow();
    }
  });

  it("loads a single good fixture as ok", async () => {
    const t = await loadTraceFile(
      path.join(fixturesRoot, "good", "settle-after-200.json"),
    );
    expect(evaluateAgentTrace(t).ok).toBe(true);
  });

  it("loads a single bad fixture as not ok", async () => {
    const t = await loadTraceFile(
      path.join(fixturesRoot, "bad", "double-charge.json"),
    );
    const result = evaluateAgentTrace(t);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.rule === "double_charge")).toBe(true);
  });
});

function formatMismatch(r: {
  file: string;
  matchedExpectation: boolean;
  result: { ok: boolean; violations: readonly { rule: string; message: string }[] };
}): string {
  return `${r.file} ok=${r.result.ok} violations=${JSON.stringify(r.result.violations)}`;
}
