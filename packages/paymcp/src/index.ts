/** openapi-to-paymcp — OpenAPI → paid MCP with real x402 facilitator settlement. */

export { X402_VERSION } from "./types/x402.js";
export type {
  PaymentRequired,
  PaymentPayload,
  PaymentAccept,
  SettlementResponse,
  PaymentResource,
  Caip2Network,
} from "./types/x402.js";

export {
  loadConfigFromEnv,
  ConfigValidationError,
  ENV_KEYS,
  type PaymcpEnvConfig,
  type PricesFile,
  type OperationPrice,
} from "./types/config.js";

export type {
  OpenApiDocument,
  CompiledOperation,
  HttpMethod,
} from "./types/openapi.js";

export {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_SIGNATURE,
  HEADER_PAYMENT_RESPONSE,
  HEADER_IDEMPOTENCY_KEY,
  encodeHeaderPayload,
  decodeHeaderPayload,
  HeaderDecodeError,
} from "./headers/codec.js";

export {
  parsePaymentRequired,
  parsePaymentPayload,
  parseSettlementResponse,
} from "./headers/validate.js";

export {
  FacilitatorSettler,
  FacilitatorHttpError,
  FacilitatorTransportError,
  FacilitatorTimeoutError,
  isRetryableFacilitatorError,
  type FacilitatorClientOptions,
  type SettleInput,
} from "./settler/facilitator.js";

export {
  buildPaymentRequired,
  buildPaymentAccept,
  buildResource,
} from "./settler/challenge.js";

export type {
  Ledger,
  LedgerEntry,
  LedgerStatus,
  RecordSettlementInput,
  BeginPendingInput,
  BeginPendingResult,
  SumSettledInput,
} from "./ledger/types.js";

export {
  SqliteLedger,
  deriveIdempotencyKey,
} from "./ledger/sqlite.js";

export { createLedger } from "./ledger/create.js";

export {
  buildPriceTable,
  loadPricesFile,
  parsePricesFile,
  isOperationPaid,
  type PriceTable,
} from "./pricing/resolve.js";

export {
  loadOpenApi,
  parseOpenApiDocument,
  compileOperations,
  defaultUpstreamBase,
} from "./compiler/openapi.js";

export { generatePaidServer } from "./compiler/generate.js";

export { paymcpPaywall, type PaywallOptions } from "./middleware/paywall.js";

export {
  createPaidMcpServer,
  runPaidMcpStdio,
  type PaidMcpServerOptions,
} from "./mcp/server.js";

export { runCli, parseArgs, printHelp } from "./cli/index.js";

export {
  createLogger,
  newRequestId,
  redactPaymentSignature,
  summarizePaymentSignatureHeader,
  requestIdPlugin,
  REQUEST_ID_HEADER,
  SimpleRateLimiter,
  registerHealthRoutes,
  type Logger,
  type LogFields,
  type LogLevel,
  type HealthOptions,
} from "./http/index.js";

export type {
  AccessControls,
  AllowlistDecision,
  BudgetDecision,
  BudgetWindow,
  BudgetsFile,
  OperationBudget,
  TenantBudgets,
} from "./controls/index.js";

export {
  loadBudgetsFile,
  parseBudgetsFile,
  parseAllowlistEnv,
  resolveAccessControls,
  checkAllowlist,
  checkBudget,
  resolveMaxDailyAtomic,
  windowStartIso,
  emptyAccessControls,
} from "./controls/index.js";
