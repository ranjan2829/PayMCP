import fp from "fastify-plugin";
import type {
  FastifyInstance,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import { createTapVerifier, createMemoryNonceCache } from "./verify.js";
import {
  TapVerificationError,
  type TapKeyLookup,
  type TapVerifier,
  type TapVerificationResult,
} from "./types.js";
import { loadTapConfigFromEnv, type TapEnvConfig } from "./config.js";

export const HEADER_SIGNATURE_INPUT = "signature-input";
export const HEADER_SIGNATURE = "signature";

export interface TapMiddlewareOptions {
  /** When true (or config.required), missing/invalid TAP fails closed with 401. */
  readonly required?: boolean;
  readonly verifier?: TapVerifier;
  readonly lookupKey?: TapKeyLookup;
  readonly config?: TapEnvConfig;
  /** Which TAP tags are accepted (default both). */
  readonly acceptedTags?: readonly ("agent-browser-auth" | "agent-payer-auth")[];
}

declare module "fastify" {
  interface FastifyRequest {
    paymcpTap?: TapVerificationResult;
  }
}

/**
 * Fastify preHandler: verify Visa TAP (RFC 9421) agent recognition signatures.
 * Fail closed when required and signature missing/invalid.
 * TAP authenticates the agent — settlement still uses x402 or Visa VIC separately.
 */
async function tapMiddlewareImpl(
  app: FastifyInstance,
  options: TapMiddlewareOptions,
): Promise<void> {
  const config = options.config ?? loadTapConfigFromEnv();
  const required = options.required ?? config.required;

  let verifier = options.verifier;
  if (verifier === undefined) {
    if (options.lookupKey === undefined) {
      if (required) {
        throw new Error(
          "TAP required but no verifier/lookupKey provided — set PAYMCP_TAP_JWKS_URL or inject lookupKey",
        );
      }
      // Optional TAP with no keys: skip verification (pass-through).
      app.decorateRequest("paymcpTap", undefined);
      return;
    }
    const nonce = createMemoryNonceCache();
    verifier = createTapVerifier({
      lookupKey: options.lookupKey,
      seenNonce: nonce.seenNonce,
      rememberNonce: nonce.rememberNonce,
      ...(config.maxWindowSeconds !== undefined
        ? { maxWindowSeconds: config.maxWindowSeconds }
        : {}),
    });
  }

  app.decorateRequest("paymcpTap", undefined);

  const hook: preHandlerHookHandler = async (request, reply) => {
    const signatureInput = header(request, HEADER_SIGNATURE_INPUT);
    const signature = header(request, HEADER_SIGNATURE);

    if (signatureInput === undefined || signature === undefined) {
      if (required) {
        await reply.code(401).send({
          error: "tap_required",
          detail:
            "Trusted Agent Protocol Signature-Input and Signature headers are required",
        });
        return;
      }
      return;
    }

    const host = header(request, "host") ?? request.hostname;
    const authority = host.split(":")[0] ?? host;
    const path = request.url.split("?")[0] ?? request.url;

    try {
      const result = await verifier!.verify({
        authority,
        path,
        signatureInputHeader: signatureInput,
        signatureHeader: signature,
      });
      if (
        options.acceptedTags !== undefined &&
        !options.acceptedTags.includes(result.tag)
      ) {
        await reply.code(401).send({
          error: "tap_tag_rejected",
          detail: `TAP tag ${result.tag} not accepted for this route`,
        });
        return;
      }
      request.paymcpTap = result;
    } catch (err) {
      if (!required && err instanceof TapVerificationError) {
        // Optional mode still fail-closed on *present but invalid* signatures.
        await reply.code(401).send({
          error: "tap_invalid",
          detail: err.message,
          code: err.code,
        });
        return;
      }
      if (err instanceof TapVerificationError) {
        await reply.code(401).send({
          error: "tap_invalid",
          detail: err.message,
          code: err.code,
        });
        return;
      }
      throw err;
    }
  };

  app.addHook("preHandler", hook);
}

export const tapAgentMiddleware = fp(tapMiddlewareImpl, {
  name: "paymcp-tap-agent",
});

function header(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string" && raw[0].length > 0) {
    return raw[0];
  }
  return undefined;
}
