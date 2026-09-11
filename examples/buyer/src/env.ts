/**
 * Env parsing for the buyer EXAMPLE. Not a protocol — just how this script
 * finds the PayMCP URL and payer key.
 */

export class BuyerEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuyerEnvError";
  }
}

export type BuyerMethod = "GET" | "POST";

export interface BuyerConfig {
  readonly privateKey: `0x${string}`;
  readonly baseUrl: string;
  readonly path: string;
  readonly method: BuyerMethod;
  readonly body: string | undefined;
  readonly networkPattern: string;
  readonly facilitatorUrl: string | undefined;
  readonly maxAmountPerPayment: string;
}

const DEFAULT_BASE = "http://127.0.0.1:8787";
const DEFAULT_PATH = "/echo";
const DEFAULT_MAX = "$1";
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export function isLiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["PAYMCP_LIVE"] === "1";
}

export function requireLiveFlag(env: NodeJS.ProcessEnv = process.env): void {
  if (!isLiveEnabled(env)) {
    throw new BuyerEnvError(
      "Refusing to pay: set PAYMCP_LIVE=1 to spend real (testnet/mainnet) funds.\n" +
        "Inspect a 402 without paying: pnpm buyer:probe\n" +
        "See examples/buyer/README.md.",
    );
  }
}

export function parsePrivateKey(raw: string | undefined): `0x${string}` {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) {
    throw new BuyerEnvError(
      "Missing EVM_PRIVATE_KEY (0x-prefixed 32-byte hex). Never commit this value.",
    );
  }
  if (!PRIVATE_KEY_RE.test(value)) {
    throw new BuyerEnvError(
      "EVM_PRIVATE_KEY must be 0x followed by 64 hex characters.",
    );
  }
  return value as `0x${string}`;
}

export function parseBuyerConfig(
  env: NodeJS.ProcessEnv = process.env,
): BuyerConfig {
  requireLiveFlag(env);
  const privateKey = parsePrivateKey(env["EVM_PRIVATE_KEY"]);
  const baseUrl = (env["DEMO_API_URL"] ?? env["PAYMCP_BUYER_URL"] ?? DEFAULT_BASE)
    .trim()
    .replace(/\/+$/, "");
  const path = normalizePath(env["PAYMCP_BUYER_PATH"] ?? DEFAULT_PATH);
  const method = parseMethod(env["PAYMCP_BUYER_METHOD"], path);
  const body = defaultBody(env["PAYMCP_BUYER_BODY"], method, path);
  const network = env["PAYMCP_NETWORK"]?.trim();
  const networkPattern =
    network !== undefined && network.length > 0 ? network : "eip155:*";
  const facilitatorUrl = emptyToUndef(env["PAYMCP_FACILITATOR_URL"]);
  const maxRaw = env["PAYMCP_BUYER_MAX_AMOUNT"]?.trim();
  const maxAmountPerPayment =
    maxRaw !== undefined && maxRaw.length > 0 ? maxRaw : DEFAULT_MAX;

  if (baseUrl.length === 0) {
    throw new BuyerEnvError("DEMO_API_URL / PAYMCP_BUYER_URL must be a URL");
  }

  return {
    privateKey,
    baseUrl,
    path,
    method,
    body,
    networkPattern,
    facilitatorUrl,
    maxAmountPerPayment,
  };
}

export function buildTargetUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}${normalizePath(path)}`;
}

/** Safe log fragment — never print the key. */
export function redactPrivateKey(key: string): string {
  if (key.length < 10) {
    return "0x****";
  }
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    return DEFAULT_PATH;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function parseMethod(raw: string | undefined, path: string): BuyerMethod {
  const value = raw?.trim().toUpperCase();
  if (value === "GET" || value === "POST") {
    return value;
  }
  if (value !== undefined && value.length > 0) {
    throw new BuyerEnvError("PAYMCP_BUYER_METHOD must be GET or POST");
  }
  return path.startsWith("/weather") ? "GET" : "POST";
}

function defaultBody(
  raw: string | undefined,
  method: BuyerMethod,
  path: string,
): string | undefined {
  if (method === "GET") {
    return undefined;
  }
  const trimmed = raw?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    return trimmed;
  }
  if (path === "/echo" || path.startsWith("/echo")) {
    return JSON.stringify({ message: "hello from @x402/fetch" });
  }
  return undefined;
}

function emptyToUndef(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  return value;
}
