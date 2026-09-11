import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  AgentTraceSchema,
  type AgentTrace,
  type EvaluateResult,
} from "./schema.js";
import { evaluateTrace } from "./rules.js";

export function evaluateAgentTrace(trace: AgentTrace): EvaluateResult {
  const violations = evaluateTrace(trace);
  return {
    ok: violations.length === 0,
    traceId: trace.id,
    violations,
  };
}

export function parseTraceJson(raw: unknown): AgentTrace {
  return AgentTraceSchema.parse(raw);
}

export async function loadTraceFile(filePath: string): Promise<AgentTrace> {
  const text = await readFile(filePath, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in ${filePath}: ${msg}`);
  }
  try {
    return parseTraceJson(json);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid agent trace in ${filePath}: ${msg}`);
  }
}

export interface FixtureRunResult {
  readonly file: string;
  readonly result: EvaluateResult;
  readonly expect?: "pass" | "fail";
  /** True when result matches fixture expect (or expect omitted and we only care about evaluate). */
  readonly matchedExpectation: boolean;
}

async function listJsonFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code =
      err !== null && typeof err === "object" && "code" in err
        ? (err as { code: unknown }).code
        : undefined;
    if (code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/**
 * Run harness over good/ and bad/ fixture directories.
 * - good/: must pass (ok === true)
 * - bad/: must fail (ok === false)
 * Returns process exit code 0 if all expectations hold.
 */
export async function runFixtureSuite(fixturesRoot: string): Promise<{
  readonly exitCode: number;
  readonly results: readonly FixtureRunResult[];
  readonly summary: string;
}> {
  const goodDir = path.join(fixturesRoot, "good");
  const badDir = path.join(fixturesRoot, "bad");
  const goodFiles = await listJsonFiles(goodDir);
  const badFiles = await listJsonFiles(badDir);

  if (goodFiles.length === 0 && badFiles.length === 0) {
    return {
      exitCode: 1,
      results: [],
      summary: `No fixtures found under ${fixturesRoot}/{good,bad}`,
    };
  }

  const results: FixtureRunResult[] = [];
  let failures = 0;

  for (const file of goodFiles) {
    const trace = await loadTraceFile(file);
    const result = evaluateAgentTrace(trace);
    const expect = trace.expect ?? "pass";
    const matchedExpectation = expect === "pass" ? result.ok : !result.ok;
    if (!matchedExpectation || !result.ok) {
      failures += 1;
    }
    results.push({
      file,
      result,
      expect,
      matchedExpectation: matchedExpectation && result.ok,
    });
  }

  for (const file of badFiles) {
    const trace = await loadTraceFile(file);
    const result = evaluateAgentTrace(trace);
    const expect = trace.expect ?? "fail";
    const matchedExpectation = expect === "fail" ? !result.ok : result.ok;
    // bad fixtures must produce violations
    if (!matchedExpectation || result.ok) {
      failures += 1;
    }
    results.push({
      file,
      result,
      expect,
      matchedExpectation: matchedExpectation && !result.ok,
    });
  }

  const passCount = results.filter((r) => r.matchedExpectation).length;
  const summary =
    failures === 0
      ? `harness-ci: PASS (${passCount}/${results.length} fixtures matched expectations)`
      : `harness-ci: FAIL (${passCount}/${results.length} fixtures matched; ${failures} mismatch)`;

  return { exitCode: failures === 0 ? 0 : 1, results, summary };
}

export function formatResult(r: FixtureRunResult): string {
  const base = path.basename(r.file);
  const dir = path.basename(path.dirname(r.file));
  const status = r.matchedExpectation ? "OK" : "MISMATCH";
  const lines = [
    `[${status}] ${dir}/${base} — trace=${r.result.traceId} ok=${r.result.ok} expect=${r.expect ?? "?"}`,
  ];
  for (const v of r.result.violations) {
    lines.push(
      `  - ${v.rule}${v.eventIndex !== undefined ? ` @event[${v.eventIndex}]` : ""}: ${v.message}`,
    );
  }
  if (!r.matchedExpectation && r.result.violations.length === 0) {
    lines.push("  - (no violations; bad fixture expected at least one)");
  }
  return lines.join("\n");
}
