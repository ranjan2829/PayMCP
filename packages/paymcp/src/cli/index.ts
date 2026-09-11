import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { generatePaidServer } from "../compiler/generate.js";
import { loadOpenApi, compileOperations, defaultUpstreamBase } from "../compiler/openapi.js";
import { buildPriceTable, loadPricesFile } from "../pricing/resolve.js";
import { loadConfigFromEnv } from "../types/config.js";
import { runPaidMcpStdio } from "../mcp/server.js";
import { createLedger } from "../ledger/create.js";
import {
  DISPUTE_HMAC_ENV,
  exportDisputePack,
} from "../dispute/pack.js";

export interface CliArgs {
  readonly openapiPath: string;
  readonly outDir: string | undefined;
  readonly pricesPath: string | undefined;
  readonly upstream: string | undefined;
  readonly allowlist: readonly string[];
  readonly serve: boolean;
  readonly help: boolean;
}

export interface DisputePackCliArgs {
  readonly command: "dispute-pack";
  readonly from: string;
  readonly to: string;
  readonly outPath: string;
  readonly ledgerPath: string | undefined;
  readonly help: boolean;
}

export type ParsedCli =
  | { readonly kind: "compile"; readonly args: CliArgs }
  | { readonly kind: "dispute-pack"; readonly args: DisputePackCliArgs };

export function parseArgs(argv: readonly string[]): CliArgs {
  const parsed = parseCli(argv);
  if (parsed.kind !== "compile") {
    throw new Error(
      "parseArgs is for compile/serve mode; use parseCli for dispute-pack",
    );
  }
  return parsed.args;
}

export function parseCli(argv: readonly string[]): ParsedCli {
  if (argv[0] === "dispute-pack") {
    return { kind: "dispute-pack", args: parseDisputePackArgs(argv.slice(1)) };
  }
  return { kind: "compile", args: parseCompileArgs(argv) };
}

function parseDisputePackArgs(argv: readonly string[]): DisputePackCliArgs {
  let from: string | undefined;
  let to: string | undefined;
  let outPath: string | undefined;
  let ledgerPath: string | undefined;
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
    if (arg === "--from") {
      const next = argv[++i];
      if (next === undefined) {
        throw new Error("--from requires an ISO-8601 timestamp");
      }
      from = next;
      continue;
    }
    if (arg === "--to") {
      const next = argv[++i];
      if (next === undefined) {
        throw new Error("--to requires an ISO-8601 timestamp");
      }
      to = next;
      continue;
    }
    if (arg === "--out") {
      const next = argv[++i];
      if (next === undefined) {
        throw new Error("--out requires a path");
      }
      outPath = next;
      continue;
    }
    if (arg === "--ledger") {
      const next = argv[++i];
      if (next === undefined) {
        throw new Error("--ledger requires a SQLite path");
      }
      ledgerPath = next;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (help) {
    return {
      command: "dispute-pack",
      from: from ?? "",
      to: to ?? "",
      outPath: outPath ?? "",
      ledgerPath,
      help: true,
    };
  }
  if (from === undefined || to === undefined || outPath === undefined) {
    throw new Error(
      "Usage: paymcp dispute-pack --from <iso> --to <iso> --out pack.json",
    );
  }
  return {
    command: "dispute-pack",
    from,
    to,
    outPath,
    ledgerPath,
    help: false,
  };
}

function parseCompileArgs(argv: readonly string[]): CliArgs {
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
    throw new Error(
      "Usage: paymcp <openapi.yaml> --out ./paid-server [--serve]\n" +
        "       paymcp dispute-pack --from <iso> --to <iso> --out pack.json",
    );
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
  paymcp dispute-pack --from <iso> --to <iso> --out pack.json
  pnpm exec paymcp ./openapi.yaml --out ./paid-server

Options (compile / serve):
  --out <dir>         Generate a runnable paid server package
  --serve             Boot stdio MCP immediately (requires env)
  --prices <file>     prices.yaml override / allowlist amounts
  --upstream <url>    Upstream API base URL
  --allow <ids>       Comma-separated tool allowlist (operationIds)
  -h, --help          Show help

Options (dispute-pack):
  --from <iso>        Inclusive lower bound (ISO-8601 created_at)
  --to <iso>          Inclusive upper bound (ISO-8601 created_at)
  --out <file>        Write signed pack JSON to this path
  --ledger <path>     SQLite ledger path (default PAYMCP_LEDGER_PATH or ./paymcp-ledger.db)

Required env (when serving / at runtime):
  PAYMCP_FACILITATOR_URL   Facilitator base (…/x402 or https://x402.org/facilitator)
  PAYMCP_PAY_TO            Recipient address
  PAYMCP_NETWORK           CAIP-2 network (e.g. eip155:84532)
  PAYMCP_ASSET             Asset contract address

Optional:
  PAYMCP_FACILITATOR_AUTH_TOKEN   Bearer token for CDP facilitator
  CDP_API_KEY_ID / CDP_API_KEY_SECRET
  PAYMCP_ASSET_NAME, PAYMCP_MAX_TIMEOUT_SECONDS, PAYMCP_SCHEME, PAYMCP_LEDGER_PATH
  PAYMCP_DATABASE_URL             Postgres ledger (dispute-pack + runtime)
  PAYMCP_DISPUTE_HMAC_SECRET      HMAC-SHA256 secret for dispute-pack signing (≥16 chars)
`;
  process.stdout.write(text);
}

export function printDisputePackHelp(): void {
  const text = `paymcp dispute-pack — export a signed chargeback evidence pack from the settlement ledger

Usage:
  paymcp dispute-pack --from <iso> --to <iso> --out pack.json [--ledger ./paymcp-ledger.db]

Required env:
  PAYMCP_DISPUTE_HMAC_SECRET   HMAC-SHA256 secret (≥16 chars)

Optional env:
  PAYMCP_LEDGER_PATH           SQLite path (default ./paymcp-ledger.db)
  PAYMCP_DATABASE_URL          Postgres URL (overrides SQLite when set)

The pack includes settled attempts only (operationId, amount, network, payer, tx,
idempotency key, timestamps), a policy/version note, contentHash, and an HMAC
signature. Full PAYMENT-SIGNATURE payloads are never exported.
`;
  process.stdout.write(text);
}

export async function runCli(argv: readonly string[]): Promise<void> {
  const parsed = parseCli(argv);

  if (parsed.kind === "dispute-pack") {
    if (parsed.args.help) {
      printDisputePackHelp();
      return;
    }
    await runDisputePackCli(parsed.args);
    return;
  }

  const args = parsed.args;
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

async function runDisputePackCli(args: DisputePackCliArgs): Promise<void> {
  const secret = process.env[DISPUTE_HMAC_ENV];
  if (secret === undefined || secret.trim().length === 0) {
    throw new Error(
      `${DISPUTE_HMAC_ENV} is required to sign dispute packs (set a secret ≥16 chars)`,
    );
  }

  const databaseUrl = process.env['PAYMCP_DATABASE_URL'];
  const ledgerPath =
    args.ledgerPath ??
    process.env['PAYMCP_LEDGER_PATH'] ??
    "./paymcp-ledger.db";

  const ledger = await createLedger({
    ledgerPath,
    ...(databaseUrl !== undefined && databaseUrl.trim().length > 0
      ? { databaseUrl: databaseUrl.trim() }
      : {}),
  });

  try {
    const pack = await exportDisputePack({
      ledger,
      from: args.from,
      to: args.to,
      hmacSecret: secret,
    });
    const out = resolve(args.outPath);
    writeFileSync(out, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
    process.stdout.write(
      `Wrote dispute pack (${pack.attempts.length} settled attempt(s)) to ${out}\n` +
        `contentHash=${pack.contentHash}\n`,
    );
  } finally {
    await ledger.close();
  }
}
