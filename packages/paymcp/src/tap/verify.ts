import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { buildTapSignatureBase } from "./signature-base.js";
import { parseSignatureHeader, parseSignatureInputHeader } from "./parse.js";
import {
  TapVerificationError,
  type TapKeyLookup,
  type TapPublicKey,
  type TapVerificationResult,
  type TapVerifyRequest,
  type TapVerifier,
} from "./types.js";

const DEFAULT_MAX_WINDOW_SECONDS = 8 * 60;

export interface CreateTapVerifierOptions {
  readonly lookupKey: TapKeyLookup;
  /** Optional nonce store — return true if nonce was already seen (replay). */
  readonly seenNonce?: (nonce: string) => boolean | Promise<boolean>;
  /** Record nonce after successful verify. */
  readonly rememberNonce?: (nonce: string, expires: number) => void | Promise<void>;
  readonly maxWindowSeconds?: number;
}

/**
 * Pluggable TAP verifier: parse → timestamps → nonce → key lookup → Ed25519/RSA verify.
 * Fails closed on any missing/invalid field.
 */
export function createTapVerifier(options: CreateTapVerifierOptions): TapVerifier {
  const maxWindow = options.maxWindowSeconds ?? DEFAULT_MAX_WINDOW_SECONDS;

  return {
    async verify(request: TapVerifyRequest): Promise<TapVerificationResult> {
      const inputs = parseSignatureInputHeader(request.signatureInputHeader);
      const signatures = parseSignatureHeader(request.signatureHeader);
      const input = pickTapInput(inputs);
      const sig = signatures.find((s) => s.label === input.label);
      if (sig === undefined) {
        throw new TapVerificationError(
          "missing_signature",
          `no Signature entry for label ${input.label}`,
        );
      }

      const now = request.nowSeconds ?? Math.floor(Date.now() / 1000);
      const window = request.maxWindowSeconds ?? maxWindow;
      validateTimestamps(input.created, input.expires, now, window);

      if (options.seenNonce !== undefined) {
        const replay = await options.seenNonce(input.nonce);
        if (replay) {
          throw new TapVerificationError("replay_nonce", "nonce already used");
        }
      }

      const key = await options.lookupKey(input.keyid);
      if (key === undefined) {
        throw new TapVerificationError(
          "unknown_keyid",
          `public key not found for keyid ${input.keyid}`,
        );
      }

      let signatureBase: string;
      try {
        signatureBase = buildTapSignatureBase({
          authority: request.authority,
          path: request.path,
          input,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new TapVerificationError("unsupported_component", msg);
      }

      const ok = verifySignatureBytes({
        alg: input.alg,
        key,
        signatureBase,
        signatureBase64: sig.signatureBase64,
      });
      if (!ok) {
        throw new TapVerificationError("invalid_signature", "signature validation failed");
      }

      if (options.rememberNonce !== undefined) {
        await options.rememberNonce(input.nonce, input.expires);
      }

      return {
        ok: true,
        label: input.label,
        keyid: input.keyid,
        alg: input.alg,
        nonce: input.nonce,
        tag: input.tag,
        created: input.created,
        expires: input.expires,
      };
    },
  };
}

/** Static map key lookup (tests / pinned merchant cache). */
export function staticTapKeyLookup(
  keys: ReadonlyMap<string, TapPublicKey> | Record<string, TapPublicKey>,
): TapKeyLookup {
  const map =
    keys instanceof Map ? keys : new Map(Object.entries(keys));
  return async (keyid) => map.get(keyid);
}

function pickTapInput(inputs: ReturnType<typeof parseSignatureInputHeader>) {
  const tap = inputs.find(
    (i) => i.tag === "agent-browser-auth" || i.tag === "agent-payer-auth",
  );
  if (tap === undefined) {
    throw new TapVerificationError(
      "missing_tap_tag",
      "no Signature-Input with agent-browser-auth or agent-payer-auth",
    );
  }
  return tap;
}

function validateTimestamps(
  created: number,
  expires: number,
  now: number,
  maxWindowSeconds: number,
): void {
  if (created > now) {
    throw new TapVerificationError("timestamp_invalid", "created is in the future");
  }
  if (expires <= now) {
    throw new TapVerificationError("timestamp_invalid", "signature expired");
  }
  if (expires - created > maxWindowSeconds) {
    throw new TapVerificationError(
      "timestamp_invalid",
      `created/expires window exceeds ${maxWindowSeconds}s`,
    );
  }
}

function verifySignatureBytes(args: {
  readonly alg: string;
  readonly key: TapPublicKey;
  readonly signatureBase: string;
  readonly signatureBase64: string;
}): boolean {
  const alg = args.alg.toLowerCase();
  const data = Buffer.from(args.signatureBase, "utf8");
  const signature = Buffer.from(args.signatureBase64, "base64");
  const keyObject = toKeyObject(args.key, alg);

  if (alg === "ed25519") {
    return cryptoVerify(null, data, keyObject, signature);
  }
  if (alg === "rsa-pss-sha256" || alg === "ps256") {
    return cryptoVerify(
      "sha256",
      data,
      { key: keyObject, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 },
      signature,
    );
  }
  throw new TapVerificationError("unsupported_alg", `unsupported TAP alg: ${args.alg}`);
}

function toKeyObject(key: TapPublicKey, alg: string): KeyObject {
  if (key.publicKeyPem !== undefined && key.publicKeyPem.length > 0) {
    return createPublicKey(key.publicKeyPem);
  }
  if (key.publicKeyRaw !== undefined && key.publicKeyRaw.length > 0) {
    if (alg === "ed25519") {
      // SPKI for Ed25519: 12-byte prefix + 32-byte raw key
      const prefix = Buffer.from("302a300506032b6570032100", "hex");
      const spki = Buffer.concat([prefix, Buffer.from(key.publicKeyRaw)]);
      return createPublicKey({ key: spki, format: "der", type: "spki" });
    }
  }
  throw new TapVerificationError("unknown_keyid", "public key material missing");
}

/** In-memory nonce cache for the last window (tests + single-process MVP). */
export function createMemoryNonceCache(maxEntries = 10_000): {
  seenNonce: (nonce: string) => boolean;
  rememberNonce: (nonce: string, expires: number) => void;
} {
  const seen = new Map<string, number>();
  return {
    seenNonce(nonce) {
      const exp = seen.get(nonce);
      if (exp === undefined) return false;
      if (exp < Math.floor(Date.now() / 1000)) {
        seen.delete(nonce);
        return false;
      }
      return true;
    },
    rememberNonce(nonce, expires) {
      if (seen.size >= maxEntries) {
        const first = seen.keys().next().value;
        if (first !== undefined) seen.delete(first);
      }
      seen.set(nonce, expires);
    },
  };
}
