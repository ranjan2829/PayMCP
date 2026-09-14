import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "js-yaml";
import type { ListingRegistry } from "../listings/registry.js";
import type { Listing } from "../listings/schemas.js";
import { SellerKit } from "../seller/kit.js";
import { fixturesDir } from "./catalog.js";

/**
 * Env required to seed the ONE live public paid tool for Base demos.
 * Fail closed — no fake payTo / facilitator / asset defaults in product code.
 */
export interface LiveListingEnv {
  readonly payTo: string;
  readonly network: string;
  readonly asset: string;
  readonly facilitatorUrl: string;
  readonly upstreamBaseUrl?: string;
  readonly force?: boolean;
}

export interface SeedLiveListingResult {
  readonly listing: Listing;
  readonly created: boolean;
  readonly network: string;
  readonly asset: string;
  readonly facilitatorUrl: string;
}

const LIVE_LISTING_ID = "lst_live_echo";

/**
 * Validate live-demo env and throw with actionable message if anything is missing.
 * Public docs default network to Base Sepolia (`eip155:84532`); mainnet via env only.
 */
export function requireLiveListingEnv(env: {
  STORE_SEED_PAY_TO?: string;
  STORE_SEED_NETWORK?: string;
  PAYMCP_ASSET?: string;
  PAYMCP_FACILITATOR_URL?: string;
  STORE_LIVE_UPSTREAM_BASE_URL?: string;
}): LiveListingEnv {
  const missing: string[] = [];
  if (env.STORE_SEED_PAY_TO === undefined || env.STORE_SEED_PAY_TO.length === 0) {
    missing.push("STORE_SEED_PAY_TO");
  }
  if (env.PAYMCP_ASSET === undefined || env.PAYMCP_ASSET.length === 0) {
    missing.push("PAYMCP_ASSET");
  }
  if (
    env.PAYMCP_FACILITATOR_URL === undefined ||
    env.PAYMCP_FACILITATOR_URL.length === 0
  ) {
    missing.push("PAYMCP_FACILITATOR_URL");
  }
  if (missing.length > 0) {
    throw new Error(
      `Live listing seed requires real env (fail closed): missing ${missing.join(", ")}. ` +
        "Set STORE_SEED_PAY_TO, PAYMCP_ASSET, PAYMCP_FACILITATOR_URL. " +
        "Default network is Base Sepolia (STORE_SEED_NETWORK=eip155:84532); use eip155:8453 for Base mainnet. " +
        "No fake addresses or placeholder keys.",
    );
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(env.STORE_SEED_PAY_TO!)) {
    throw new Error("STORE_SEED_PAY_TO must be a 0x-prefixed 40-hex EVM address");
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(env.PAYMCP_ASSET!)) {
    throw new Error("PAYMCP_ASSET must be a 0x-prefixed 40-hex USDC contract address");
  }
  try {
    // eslint-disable-next-line no-new
    new URL(env.PAYMCP_FACILITATOR_URL!);
  } catch {
    throw new Error("PAYMCP_FACILITATOR_URL must be a valid URL");
  }

  return {
    payTo: env.STORE_SEED_PAY_TO!,
    network: env.STORE_SEED_NETWORK ?? "eip155:84532",
    asset: env.PAYMCP_ASSET!,
    facilitatorUrl: env.PAYMCP_FACILITATOR_URL!,
    ...(env.STORE_LIVE_UPSTREAM_BASE_URL !== undefined
      ? { upstreamBaseUrl: env.STORE_LIVE_UPSTREAM_BASE_URL }
      : {}),
  };
}

/**
 * Seed ONE production-oriented public paid tool (echo) for the live Base receipt demo.
 * Uses only real env-provided payTo / network / asset / facilitator — never placeholders.
 */
export function seedLiveListing(
  listings: ListingRegistry,
  live: LiveListingEnv,
): SeedLiveListingResult {
  const existing = listings.findById(LIVE_LISTING_ID);
  if (existing !== undefined && live.force !== true) {
    return {
      listing: existing,
      created: false,
      network: live.network,
      asset: live.asset,
      facilitatorUrl: live.facilitatorUrl,
    };
  }
  if (existing !== undefined && live.force === true) {
    listings.delete(LIVE_LISTING_ID);
  }

  const dir = fixturesDir();
  const raw = YAML.load(
    readFileSync(join(dir, "echo.openapi.yaml"), "utf8"),
  ) as unknown;
  const kit = new SellerKit(listings);
  const upstream = live.upstreamBaseUrl ?? "http://127.0.0.1:8787";

  const { listing } = kit.register({
    listingId: LIVE_LISTING_ID,
    openapi: raw,
    name: "Live Echo (Base demo)",
    description:
      "Public paid tool for live Base receipt demos — unpaid 402 → credit/x402 settle → public receipt URL.",
    sellerId: "seller_live",
    payTo: live.payTo,
    network: live.network,
    upstreamBaseUrl: upstream,
    externalX402: false,
    tags: ["live", "base", "demo", "receipt"],
  });

  return {
    listing,
    created: true,
    network: live.network,
    asset: live.asset,
    facilitatorUrl: live.facilitatorUrl,
  };
}

export const LIVE_PUBLIC_LISTING_ID = LIVE_LISTING_ID;
