import {
  compileOperations,
  loadOpenApi,
  parseOpenApiDocument,
  buildPriceTable,
  loadPricesFile,
  type CompiledOperation,
  type OpenApiDocument,
  type PricesFile,
  type PriceTable,
} from "openapi-to-paymcp";
import { StoreError } from "../errors/index.js";
import type { ListingRegistry } from "../listings/registry.js";
import type { CreateListingInput, Listing } from "../listings/schemas.js";
import { CreateListingInputSchema } from "../listings/schemas.js";

export interface SellerKitPriceOverride {
  readonly operationId: string;
  readonly amount: string;
  readonly description?: string;
  readonly paid?: boolean;
}

export interface CompileSellerListingInput {
  /** Path to OpenAPI file, or omit when openapi/openapiUrl provided. */
  readonly openapiPath?: string;
  readonly openapiUrl?: string;
  readonly openapi?: unknown;
  /** Optional prices.yaml path (wins over x-paymcp extensions). */
  readonly pricesPath?: string;
  readonly prices?: PricesFile;
  readonly priceOverrides?: readonly SellerKitPriceOverride[];
  readonly name: string;
  readonly description?: string;
  readonly sellerId: string;
  readonly payTo: string;
  readonly network: string;
  readonly listingId?: string;
  readonly upstreamBaseUrl?: string;
  readonly defaultPath?: string;
  readonly defaultMethod?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly externalX402?: boolean;
  readonly tags?: readonly string[];
  /**
   * When multiple paid ops exist, pick this operationId for the listing
   * default price/path. Defaults to first paid compiled op.
   */
  readonly primaryOperationId?: string;
}

export interface CompiledSellerListing {
  readonly document: OpenApiDocument;
  readonly operations: readonly CompiledOperation[];
  readonly priceTable: PriceTable;
  readonly primary: CompiledOperation;
  readonly listingInput: CreateListingInput;
}

/**
 * Seller kit: OpenAPI (+ optional prices) → compiled ops + CreateListingInput.
 * Registers via ListingRegistry when `register` is called.
 */
export class SellerKit {
  constructor(private readonly listings: ListingRegistry) {}

  /**
   * Compile OpenAPI into a listing draft. Does not persist until register().
   */
  compile(input: CompileSellerListingInput): CompiledSellerListing {
    const document = loadDocument(input);
    const operations = compileOperations(document);
    if (operations.length === 0) {
      throw new StoreError(
        "LISTING_INVALID",
        "OpenAPI document has no operations",
        400,
      );
    }

    let pricesFile = input.prices;
    if (pricesFile === undefined && input.pricesPath !== undefined) {
      pricesFile = loadPricesFile(input.pricesPath);
    }
    if (input.priceOverrides !== undefined && input.priceOverrides.length > 0) {
      const ops = [
        ...(pricesFile?.operations ?? []),
        ...input.priceOverrides.map((o) => ({
          operationId: o.operationId,
          amount: o.amount,
          ...(o.description !== undefined ? { description: o.description } : {}),
          ...(o.paid !== undefined ? { paid: o.paid } : {}),
        })),
      ];
      pricesFile = { version: 1, operations: ops };
    }

    const priceTable = buildPriceTable(
      operations,
      pricesFile !== undefined ? pricesFile : undefined,
    );

    const paidOps = operations.filter((op) => {
      const price = priceTable.byOperationId.get(op.operationId);
      if (price !== undefined) {
        return price.paid !== false;
      }
      return op.paid && op.amount !== undefined;
    });

    if (paidOps.length === 0) {
      throw new StoreError(
        "LISTING_INVALID",
        "no paid operations found — set x-paymcp amounts or prices.yaml",
        400,
      );
    }

    const primary =
      input.primaryOperationId !== undefined
        ? paidOps.find((o) => o.operationId === input.primaryOperationId)
        : paidOps[0];
    if (primary === undefined) {
      throw new StoreError(
        "LISTING_INVALID",
        `primary operation not found: ${input.primaryOperationId ?? "(first)"}`,
        400,
      );
    }

    const priceEntry = priceTable.byOperationId.get(primary.operationId);
    const amount = priceEntry?.amount ?? primary.amount;
    if (amount === undefined || !/^\d+$/.test(amount)) {
      throw new StoreError(
        "LISTING_INVALID",
        `primary operation ${primary.operationId} has no atomic price`,
        400,
      );
    }

    const upstreamBaseUrl =
      input.upstreamBaseUrl ??
      document.servers?.[0]?.url ??
      undefined;

    const openapiSnapshot =
      input.openapi !== undefined
        ? (input.openapi as Record<string, unknown>)
        : (document as unknown as Record<string, unknown>);

    const listingInput: CreateListingInput = {
      ...(input.listingId !== undefined ? { id: input.listingId } : {}),
      name: input.name,
      description:
        input.description ??
        document.info.description ??
        primary.description ??
        "",
      ...(input.openapiUrl !== undefined
        ? { openapiUrl: input.openapiUrl }
        : { openapi: openapiSnapshot }),
      price: amount,
      sellerId: input.sellerId,
      payTo: input.payTo,
      network: input.network,
      status: "active",
      ...(upstreamBaseUrl !== undefined ? { upstreamBaseUrl } : {}),
      defaultPath: input.defaultPath ?? primary.path,
      defaultMethod: (input.defaultMethod ??
        primary.method.toUpperCase()) as CreateListingInput["defaultMethod"],
      externalX402: input.externalX402 ?? false,
      tags: [...(input.tags ?? []), "seller-kit", primary.operationId],
    };

    // Validate early so register() won't surprise.
    CreateListingInputSchema.parse(listingInput);

    return {
      document,
      operations,
      priceTable,
      primary,
      listingInput,
    };
  }

  /** Compile + persist listing. */
  register(input: CompileSellerListingInput): {
    listing: Listing;
    compiled: CompiledSellerListing;
  } {
    const compiled = this.compile(input);
    const listing = this.listings.create(compiled.listingInput);
    return { listing, compiled };
  }
}

function loadDocument(input: CompileSellerListingInput): OpenApiDocument {
  if (input.openapiPath !== undefined) {
    return loadOpenApi(input.openapiPath);
  }
  if (input.openapi !== undefined) {
    return parseOpenApiDocument(input.openapi);
  }
  if (input.openapiUrl !== undefined) {
    // URL-only: store the URL on the listing; compile requires a document.
    // Sellers should pass openapi snapshot or path for compile. For URL-only
    // registration without compile, use ListingRegistry.create directly.
    throw new StoreError(
      "LISTING_INVALID",
      "SellerKit.compile requires openapiPath or inline openapi (openapiUrl alone is for registry create)",
      400,
    );
  }
  throw new StoreError(
    "LISTING_INVALID",
    "provide openapiPath or inline openapi",
    400,
  );
}
