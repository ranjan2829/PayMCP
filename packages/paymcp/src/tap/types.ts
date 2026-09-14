/**
 * Visa Trusted Agent Protocol (TAP) — RFC 9421 HTTP Message Signatures.
 * TAP authenticates the agent; it does not move money by itself.
 * @see https://developer.visa.com/capabilities/trusted-agent-protocol/
 */

export const TAP_TAGS = ["agent-browser-auth", "agent-payer-auth"] as const;
export type TapTag = (typeof TAP_TAGS)[number];

export const TAP_ALGS = ["ed25519", "Ed25519", "rsa-pss-sha256", "PS256"] as const;

/** Parsed Signature-Input dictionary entry (one label, e.g. sig2). */
export interface TapSignatureInput {
  readonly label: string;
  /** Covered components, e.g. ["@authority", "@path"]. */
  readonly coveredComponents: readonly string[];
  readonly created: number;
  readonly expires: number;
  readonly keyid: string;
  readonly alg: string;
  readonly nonce: string;
  readonly tag: TapTag;
  /** Raw params segment used to rebuild @signature-params (without label=). */
  readonly paramsInner: string;
}

export interface TapSignature {
  readonly label: string;
  /** Raw base64 (standard) signature bytes from `:…:` sf-binary. */
  readonly signatureBase64: string;
}

export interface TapVerifyRequest {
  readonly authority: string;
  readonly path: string;
  readonly signatureInputHeader: string;
  readonly signatureHeader: string;
  /** Unix seconds; defaults to now. */
  readonly nowSeconds?: number;
  /** Max created→expires window (Visa: 8 minutes). Default 480. */
  readonly maxWindowSeconds?: number;
}

export interface TapVerificationResult {
  readonly ok: true;
  readonly label: string;
  readonly keyid: string;
  readonly alg: string;
  readonly nonce: string;
  readonly tag: TapTag;
  readonly created: number;
  readonly expires: number;
}

export type TapKeyLookup = (keyid: string) => Promise<TapPublicKey | undefined>;

export interface TapPublicKey {
  readonly keyid: string;
  /** Node KeyObject-compatible: Ed25519 SPKI PEM, or raw 32-byte public key. */
  readonly publicKeyPem?: string;
  readonly publicKeyRaw?: Uint8Array;
  readonly alg?: string;
}

export interface TapVerifier {
  verify(request: TapVerifyRequest): Promise<TapVerificationResult>;
}

export class TapVerificationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TapVerificationError";
    this.code = code;
  }
}
