import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatResult,
  loadTraceFile,
  evaluateAgentTrace,
  runFixtureSuite,
} from "./evaluate.js";
import { POLICY_RULES } from "./rules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Default fixtures live next to the package (packages/harness-ci/fixtures). */
export function defaultFixturesRoot(): string {
  return path.resolve(__dirname, "..", "fixtures");
}

export async function runCli(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return 0;
  }
  if (argv.includes("--list-rules")) {
    for (const r of POLICY_RULES) {
      console.log(`${r.id}\n  ${r.summary}`);
    }
    return 0;
  }

  const fileIdx = argv.indexOf("--file");
  if (fileIdx !== -1) {
    const file = argv[fileIdx + 1];
    if (file === undefined) {
      console.error("harness-ci: --file requires a path");
      return 1;
    }
    const trace = await loadTraceFile(path.resolve(file));
    const result = evaluateAgentTrace(trace);
    if (result.ok) {
      console.log(`PASS ${result.traceId}`);
      return 0;
    }
    console.error(`FAIL ${result.traceId}`);
    for (const v of result.violations) {
      console.error(
        `  - ${v.rule}${v.eventIndex !== undefined ? ` @event[${v.eventIndex}]` : ""}: ${v.message}`,
      );
    }
    return 1;
  }

  let fixturesRoot = defaultFixturesRoot();
  const rootIdx = argv.indexOf("--fixtures");
  if (rootIdx !== -1) {
    const root = argv[rootIdx + 1];
    if (root === undefined) {
      console.error("harness-ci: --fixtures requires a directory");
      return 1;
    }
    fixturesRoot = path.resolve(root);
  }

  const { exitCode, results, summary } = await runFixtureSuite(fixturesRoot);
  for (const r of results) {
    console.log(formatResult(r));
  }
  console.log(summary);
  return exitCode;
}

function printHelp(): void {
  console.log(`paymcp-harness-ci — agent-trace quality gate for PayMCP

Usage:
  pnpm harness:ci                     Run good/bad fixture suite (CI default)
  pnpm harness:ci -- --file PATH      Evaluate a single trace JSON
  pnpm harness:ci -- --fixtures DIR   Custom fixtures root (expects good/ + bad/)
  pnpm harness:ci -- --list-rules     Print enforced policy rules
  pnpm harness:ci -- --help

Exit codes:
  0  all good fixtures pass and all bad fixtures fail (or --file trace is clean)
  1  policy violation or fixture expectation mismatch

Policies align with PayMCP production: settle on 2xx only, Idempotency-Key,
no double-charge, per-tool budgets, redacted secrets in traces.
`);
}

// Allow `tsx src/cli.ts` direct execution.
const isDirect =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirect) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
