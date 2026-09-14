import { describe, it, expect } from "vitest";
import {
  createTapVerifier,
  staticTapKeyLookup,
  createMemoryNonceCache,
  TapVerificationError,
  parseSignatureInputHeader,
  loadTapConfigFromEnv,
  ConfigValidationError,
} from "../../src/index.js";
import { generateTapTestKeypair, signTapHeaders } from "../fixtures/tap.js";

describe("TAP RFC 9421 verifier", () => {
  it("verifies a synthetic Ed25519 agent-payer-auth signature", async () => {
    const kp = generateTapTestKeypair("kid-test-1");
    const signed = signTapHeaders({
      keypair: kp,
      authority: "merchant.example",
      path: "/v1/paid/echo",
      tag: "agent-payer-auth",
    });
    const nonce = createMemoryNonceCache();
    const verifier = createTapVerifier({
      lookupKey: staticTapKeyLookup({ [kp.keyid]: kp.publicKey }),
      seenNonce: nonce.seenNonce,
      rememberNonce: nonce.rememberNonce,
    });
    const result = await verifier.verify({
      authority: "merchant.example",
      path: "/v1/paid/echo",
      signatureInputHeader: signed.signatureInput,
      signatureHeader: signed.signature,
    });
    expect(result.ok).toBe(true);
    expect(result.tag).toBe("agent-payer-auth");
    expect(result.keyid).toBe(kp.keyid);
  });

  it("fails closed on missing Signature-Input fields", () => {
    expect(() =>
      parseSignatureInputHeader('sig2=("@authority");created=1'),
    ).toThrow(TapVerificationError);
  });

  it("rejects expired signatures", async () => {
    const kp = generateTapTestKeypair();
    const now = Math.floor(Date.now() / 1000);
    const signed = signTapHeaders({
      keypair: kp,
      authority: "example.com",
      path: "/x",
      created: now - 600,
      expires: now - 100,
    });
    const verifier = createTapVerifier({
      lookupKey: staticTapKeyLookup({ [kp.keyid]: kp.publicKey }),
    });
    await expect(
      verifier.verify({
        authority: "example.com",
        path: "/x",
        signatureInputHeader: signed.signatureInput,
        signatureHeader: signed.signature,
        nowSeconds: now,
      }),
    ).rejects.toMatchObject({ code: "timestamp_invalid" });
  });

  it("rejects replayed nonces", async () => {
    const kp = generateTapTestKeypair();
    const signed = signTapHeaders({
      keypair: kp,
      authority: "example.com",
      path: "/x",
      nonce: "same-nonce-once",
    });
    const nonce = createMemoryNonceCache();
    const verifier = createTapVerifier({
      lookupKey: staticTapKeyLookup({ [kp.keyid]: kp.publicKey }),
      seenNonce: nonce.seenNonce,
      rememberNonce: nonce.rememberNonce,
    });
    await verifier.verify({
      authority: "example.com",
      path: "/x",
      signatureInputHeader: signed.signatureInput,
      signatureHeader: signed.signature,
    });
    await expect(
      verifier.verify({
        authority: "example.com",
        path: "/x",
        signatureInputHeader: signed.signatureInput,
        signatureHeader: signed.signature,
      }),
    ).rejects.toMatchObject({ code: "replay_nonce" });
  });

  it("rejects tampered path", async () => {
    const kp = generateTapTestKeypair();
    const signed = signTapHeaders({
      keypair: kp,
      authority: "example.com",
      path: "/paid",
    });
    const verifier = createTapVerifier({
      lookupKey: staticTapKeyLookup({ [kp.keyid]: kp.publicKey }),
    });
    await expect(
      verifier.verify({
        authority: "example.com",
        path: "/other",
        signatureInputHeader: signed.signatureInput,
        signatureHeader: signed.signature,
      }),
    ).rejects.toMatchObject({ code: "invalid_signature" });
  });
});

describe("loadTapConfigFromEnv", () => {
  it("allows TAP off without JWKS", () => {
    const cfg = loadTapConfigFromEnv({});
    expect(cfg.required).toBe(false);
  });

  it("fails closed when required without JWKS", () => {
    expect(() =>
      loadTapConfigFromEnv({ PAYMCP_TAP_REQUIRED: "1" }),
    ).toThrow(ConfigValidationError);
  });

  it("accepts JWKS URL when required", () => {
    const cfg = loadTapConfigFromEnv({
      PAYMCP_TAP_REQUIRED: "1",
      PAYMCP_TAP_JWKS_URL: "https://mcp.visa.com/.well-known/jwks",
    });
    expect(cfg.required).toBe(true);
    expect(cfg.jwksUrl).toContain("mcp.visa.com");
  });
});
