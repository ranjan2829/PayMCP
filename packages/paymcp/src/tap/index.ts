export {
  TAP_TAGS,
  TAP_ALGS,
  TapVerificationError,
  type TapTag,
  type TapSignatureInput,
  type TapSignature,
  type TapVerifyRequest,
  type TapVerificationResult,
  type TapKeyLookup,
  type TapPublicKey,
  type TapVerifier,
} from "./types.js";

export {
  parseSignatureInputHeader,
  parseSignatureHeader,
} from "./parse.js";

export { buildTapSignatureBase } from "./signature-base.js";

export {
  createTapVerifier,
  staticTapKeyLookup,
  createMemoryNonceCache,
  type CreateTapVerifierOptions,
} from "./verify.js";

export {
  TAP_ENV_KEYS,
  loadTapConfigFromEnv,
  type TapEnvConfig,
} from "./config.js";

export {
  tapAgentMiddleware,
  HEADER_SIGNATURE,
  HEADER_SIGNATURE_INPUT,
  type TapMiddlewareOptions,
} from "./middleware.js";
