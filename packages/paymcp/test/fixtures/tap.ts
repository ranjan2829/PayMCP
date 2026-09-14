import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import { buildTapSignatureBase } from "../../src/tap/signature-base.js";
import type { TapPublicKey, TapSignatureInput, TapTag } from "../../src/tap/types.js";

export interface TapTestKeypair {
  readonly keyid: string;
  readonly privateKey: KeyObject;
  readonly publicKey: TapPublicKey;
}

/** Generate an ephemeral Ed25519 keypair for unit tests only — never ship as product defaults. */
export function generateTapTestKeypair(keyid = "test-tap-ed25519"): TapTestKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    keyid,
    privateKey,
    publicKey: { keyid, publicKeyPem, alg: "Ed25519" },
  };
}

export function signTapHeaders(args: {
  readonly keypair: TapTestKeypair;
  readonly authority: string;
  readonly path: string;
  readonly tag?: TapTag;
  readonly created?: number;
  readonly expires?: number;
  readonly nonce?: string;
  readonly label?: string;
}): { signatureInput: string; signature: string; input: TapSignatureInput } {
  const label = args.label ?? "sig2";
  const created = args.created ?? Math.floor(Date.now() / 1000) - 1;
  const expires = args.expires ?? created + 300;
  const nonce =
    args.nonce ??
    Buffer.from(`nonce-${created}-${Math.random()}`).toString("base64url");
  const tag = args.tag ?? "agent-payer-auth";
  const keyid = args.keypair.keyid;
  const alg = "Ed25519";

  const paramsInner =
    `("@authority" "@path");created=${created};expires=${expires};` +
    `keyid="${keyid}";alg="${alg}";nonce="${nonce}";tag="${tag}"`;

  const input: TapSignatureInput = {
    label,
    coveredComponents: ["@authority", "@path"],
    created,
    expires,
    keyid,
    alg,
    nonce,
    tag,
    paramsInner,
  };

  const base = buildTapSignatureBase({
    authority: args.authority,
    path: args.path,
    input,
  });
  const sig = cryptoSign(null, Buffer.from(base, "utf8"), args.keypair.privateKey);
  const signatureBase64 = sig.toString("base64");

  return {
    signatureInput: `${label}=${paramsInner}`,
    signature: `${label}=:${signatureBase64}:`,
    input,
  };
}
