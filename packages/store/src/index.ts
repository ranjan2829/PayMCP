/** @paymcp/store — paid-agent-tools marketplace on openapi-to-paymcp. */

export const STORE_PACKAGE_NAME = "@paymcp/store" as const;
export const STORE_PACKAGE_VERSION = "0.1.0" as const;

export { StoreError, isStoreError, type StoreErrorCode } from "./errors/index.js";
export { openStoreDb } from "./db.js";
export {
  loadStoreEnv,
  requireSeedPayTo,
  isStripeFundingEnabled,
  isUsdcPayoutConfigured,
  type StoreEnvConfig,
} from "./config/env.js";
export {
  AtomicAmountSchema,
  ListingStatusSchema,
  ListingIdSchema,
  Caip2NetworkSchema,
  OpenApiSourceSchema,
  CreateListingInputSchema,
  UpdateListingInputSchema,
  ListingSchema,
  CatalogQuerySchema,
  ListingRegistry,
  type ListingStatus,
  type CreateListingInput,
  type CreateListingParsed,
  type UpdateListingInput,
  type Listing,
  type CatalogQuery,
} from "./listings/index.js";
export {
  BuyerIdSchema,
  CreditFundingInputSchema,
  TopUpInputSchema,
  BalanceSchema,
  SpendLogEntrySchema,
  SpendLogQuerySchema,
  BuyerBalanceLedger,
  type CreditFundingInput,
  type TopUpInput,
  type Balance,
  type SpendLogEntry,
  type SpendLogQuery,
  type BeginSpendInput,
  type BeginSpendResult,
  type CompleteSpendInput,
} from "./ledger/index.js";
export {
  InvokeGateway,
  buildUpstreamUrl,
  newIdempotencyKey,
  registerStoreRoutes,
  createStoreApp,
  type InvokeRequest,
  type InvokeSuccess,
  type InvokeGatewayOptions,
  type StoreAppDeps,
  type CreateStoreAppOptions,
  type StoreApp,
} from "./gateway/index.js";
export {
  SellerKit,
  type SellerKitPriceOverride,
  type CompileSellerListingInput,
  type CompiledSellerListing,
} from "./seller/index.js";
export {
  seedCatalog,
  fixturesDir,
  type SeedCatalogOptions,
  type SeedCatalogResult,
} from "./seed/index.js";
export {
  StripeFundingClient,
  verifyStripeSignature,
  creditsForUsdCents,
  type StripeCheckoutInput,
  type StripeCheckoutSession,
  type StripeClientOptions,
} from "./funding/index.js";
export {
  SellerPayoutQueue,
  SellerPayoutService,
  FacilitatorSellerPayout,
  UsdcTransferPayout,
  RecordingPayoutExecutor,
  type SellerPayout,
  type SellerPayoutExecutor,
  type PayoutExecutionResult,
} from "./payout/index.js";
export { runStoreCli } from "./cli/index.js";
