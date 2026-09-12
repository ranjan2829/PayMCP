/** @paymcp/store — paid-agent-tools marketplace on openapi-to-paymcp. */

export const STORE_PACKAGE_NAME = "@paymcp/store" as const;
export const STORE_PACKAGE_VERSION = "0.1.0" as const;

export { StoreError, isStoreError, type StoreErrorCode } from "./errors/index.js";
export { openStoreDb } from "./db.js";
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
  TopUpInputSchema,
  BalanceSchema,
  SpendLogEntrySchema,
  SpendLogQuerySchema,
  BuyerBalanceLedger,
  type TopUpInput,
  type Balance,
  type SpendLogEntry,
  type SpendLogQuery,
  type BeginSpendInput,
  type BeginSpendResult,
  type CompleteSpendInput,
} from "./ledger/index.js";
