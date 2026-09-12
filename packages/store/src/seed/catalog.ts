import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "js-yaml";
import type { ListingRegistry } from "../listings/registry.js";
import type { Listing } from "../listings/schemas.js";
import { SellerKit } from "../seller/kit.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Resolve fixtures dir whether running from src/ or dist/. */
export function fixturesDir(): string {
  const candidates = [
    join(HERE, "../../fixtures"),
    join(HERE, "../../../fixtures"),
    join(process.cwd(), "packages/store/fixtures"),
    join(process.cwd(), "fixtures"),
  ];
  for (const c of candidates) {
    try {
      readFileSync(join(c, "echo.openapi.yaml"));
      return c;
    } catch {
      // try next
    }
  }
  return join(HERE, "../../fixtures");
}

export interface SeedCatalogOptions {
  readonly listings: ListingRegistry;
  readonly network: string;
  readonly payTo: string;
  readonly sellerId?: string;
  /**
   * Upstream for local demo listings (echo/weather). Defaults to demo-api.
   */
  readonly demoUpstreamBaseUrl?: string;
  /** Re-seed even if listing ids already exist (updates in place). */
  readonly force?: boolean;
}

export interface SeedCatalogResult {
  readonly listings: Listing[];
  readonly created: string[];
  readonly skipped: string[];
}

/**
 * Seed 2–3 demo listings:
 * 1. echo (local demo) — $0.01
 * 2. weather (local demo) — $0.025
 * 3. grawwww render/image — 0.10 USDC external x402 live target
 */
export function seedCatalog(options: SeedCatalogOptions): SeedCatalogResult {
  const sellerId = options.sellerId ?? "seller_demo";
  const demoBase = options.demoUpstreamBaseUrl ?? "http://127.0.0.1:8787";
  const kit = new SellerKit(options.listings);
  const dir = fixturesDir();
  const created: string[] = [];
  const skipped: string[] = [];
  const out: Listing[] = [];

  const specs: Array<{
    id: string;
    file: string;
    name: string;
    description: string;
    upstreamBaseUrl: string;
    externalX402: boolean;
    tags: string[];
  }> = [
    {
      id: "lst_echo_demo",
      file: "echo.openapi.yaml",
      name: "Echo Tool",
      description: "Demo paid echo — store balance path",
      upstreamBaseUrl: demoBase,
      externalX402: false,
      tags: ["demo", "echo"],
    },
    {
      id: "lst_weather_demo",
      file: "weather.openapi.yaml",
      name: "Weather Tool",
      description: "Demo paid weather lookup — store balance path",
      upstreamBaseUrl: demoBase,
      externalX402: false,
      tags: ["demo", "weather"],
    },
    {
      id: "lst_grawwww_render",
      file: "grawwww.openapi.yaml",
      name: "grawwww render/image",
      description:
        "External live x402 target at https://grawwww.xyz/api/render/image (0.10 USDC). Use @x402/fetch for on-chain payment, or point upstream at a mock for balance-path tests.",
      upstreamBaseUrl: "https://grawwww.xyz",
      externalX402: true,
      tags: ["external", "x402", "grawwww", "live"],
    },
  ];

  for (const spec of specs) {
    const existing = options.listings.findById(spec.id);
    if (existing !== undefined && options.force !== true) {
      skipped.push(spec.id);
      out.push(existing);
      continue;
    }
    if (existing !== undefined && options.force === true) {
      options.listings.delete(spec.id);
    }

    const raw = YAML.load(
      readFileSync(join(dir, spec.file), "utf8"),
    ) as unknown;

    const { listing } = kit.register({
      listingId: spec.id,
      openapi: raw,
      name: spec.name,
      description: spec.description,
      sellerId,
      payTo: options.payTo,
      network: options.network,
      upstreamBaseUrl: spec.upstreamBaseUrl,
      externalX402: spec.externalX402,
      tags: spec.tags,
    });
    created.push(listing.id);
    out.push(listing);
  }

  return { listings: out, created, skipped };
}
