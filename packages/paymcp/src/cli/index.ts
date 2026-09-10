import { resolve } from "node:path";
import { generatePaidServer } from "../compiler/generate.js";
import { loadOpenApi, compileOperations, defaultUpstreamBase } from "../compiler/openapi.js";
import { buildPriceTable, loadPricesFile } from "../pricing/resolve.js";
import { loadConfigFromEnv } from "../types/config.js";
import { runPaidMcpStdio } from "../mcp/server.js";

export interface CliArgs {
  readonly openapiPath: string;
  readonly outDir: string | undefined;
  readonly pricesPath: string | undefined;
  readonly upstream: string | undefined;
  readonly allowlist: readonly string[];
  readonly serve: boolean;
  readonly help: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  let openapiPath: string | undefined;
  let outDir: string | undefined;
  let pricesPath: string | undefined;
  let upstream: string | undefined;
  const allowlist: string[] = [];
  let serve = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      break;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--serve") {
      serve = true;
      continue;
    }
    if (arg === "--out") {
      const next = argv[++i];
      if (next === undefined) {
        throw new Error("--out requires a path");
      }
      outDir = next;
      continue;
    }
    if (arg === "--prices") {
      const next = argv[++i];
      if (next === undefined) {
        throw new Error("--prices requires a path");
      }
      pricesPath = next;
      continue;
    }
    if (arg === "--upstream") {
      const next = argv[++i];
      if (next === undefined) {
        throw new Error("--upstream requires a URL");
      }
      upstream = next;
      continue;
    }
    if (arg === "--allow") {
      const next = argv[++i];
      if (next === undefined) {
        throw new Error("--allow requires a comma-separated operationId list");
      }
      for (const id of next.split(",")) {
        const trimmed = id.trim();
        if (trimmed.length > 0) {
          allowlist.push(trimmed);
        }
      }
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    if (openapiPath === undefined) {
      openapiPath = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (help) {
    return {
      openapiPath: openapiPath ?? "",
      outDir,
      pricesPath,
      upstream,
      allowlist,
      serve,
      help,
    };
  }
  if (openapiPath === undefined) {
    throw new Error("Usage: paymcp <openapi.yaml> --out ./paid-server [--serve]");
  }
  return {
    openapiPath,
    outDir,
    pricesPath,
    upstream,
    allowlist,
    serve,
    help,
  };
}

export function printHelp(): void {
  const text = `paymcp — compile an OpenAPI spec into a paid MCP server (real x402 settlement)

Usage:
  paymcp <openapi.yaml> --out ./paid-server
  paymcp <openapi.yaml> --serve [--upstream http://127.0.0.1:8787]
  pnpm exec paymcp ./openapi.yaml --out ./paid-server

Options:
  --out <dir>         Generate a runnable paid server package
  --serve             Boot stdio MCP immediately (requires env)
  --prices <file>     prices.yaml override / allowlist amounts
  --upstream <url>    Upstream API base URL
  --allow <ids>       Comma-separated tool allowlist (operationIds)
  -h, --help          Show help

Required env (when serving / at runtime):
  PAYMCP_FACILITATOR_URL   Facilitator base (…/x402 or https://x402.org/facilitator)
  PAYMCP_PAY_TO            Recipient address
  PAYMCP_NETWORK           CAIP-2 network (e.g. eip155:84532)
  PAYMCP_ASSET             Asset contract address

Optional:
  PAYMCP_FACILITATOR_AUTH_TOKEN   Bearer token for CDP facilitator
  CDP_API_KEY_ID / CDP_API_KEY_SECRET
  PAYMCP_ASSET_NAME, PAYMCP_MAX_TIMEOUT_SECONDS, PAYMCP_SCHEME, PAYMCP_LEDGER_PATH
`;
  process.stdout.write(text);
}

export async function runCli(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  if (args.serve) {
    const config = loadConfigFromEnv();
    const doc = loadOpenApi(resolve(args.openapiPath));
    const operations = compileOperations(doc);
    const pricesFile =
      args.pricesPath !== undefined
        ? loadPricesFile(resolve(args.pricesPath))
        : undefined;
    const prices = buildPriceTable(operations, pricesFile);
    const upstreamBaseUrl =
      args.upstream !== undefined && args.upstream.length > 0
        ? args.upstream
        : defaultUpstreamBase(doc);
    await runPaidMcpStdio({
      config,
      operations,
      prices,
      upstreamBaseUrl,
      ...(args.allowlist.length > 0 ? { allowlist: args.allowlist } : {}),
    });
    return;
  }

  if (args.outDir === undefined) {
    throw new Error("Provide --out <dir> or --serve");
  }

  generatePaidServer({
    openapiPath: resolve(args.openapiPath),
    outDir: resolve(args.outDir),
    ...(args.pricesPath !== undefined
      ? { pricesPath: resolve(args.pricesPath) }
      : {}),
    ...(args.upstream !== undefined ? { upstreamBaseUrl: args.upstream } : {}),
    ...(args.allowlist.length > 0 ? { allowlist: args.allowlist } : {}),
  });

  process.stdout.write(
    `Generated paid MCP server at ${resolve(args.outDir)}\n` +
      `Set PAYMCP_* env vars (see ${resolve(args.outDir)}/.env.example) then:\n` +
      `  node ${resolve(args.outDir)}/src/server.js\n`,
  );
}
