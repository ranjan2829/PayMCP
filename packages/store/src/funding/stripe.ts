import { createHmac, timingSafeEqual } from "node:crypto";
import { StoreError } from "../errors/index.js";

export interface StripeCheckoutInput {
  readonly buyerId: string;
  /** Atomic credit units to mint after verified payment. */
  readonly creditAmount: string;
  /** Fiat amount in the smallest currency unit (e.g. cents). */
  readonly fiatAmountCents: number;
  readonly currency?: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly customerEmail?: string;
}

export interface StripeCheckoutSession {
  readonly id: string;
  readonly url: string;
}

export interface StripeClientOptions {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly fetchImpl?: typeof fetch;
  /** Credits per USD (default 1_000_000 atomic = $1 at 6 decimals). */
  readonly creditsPerUsd?: bigint;
}

/**
 * Stripe Checkout + webhook verification for fiat → store credits.
 * Fail-closed: missing keys throw; unsigned webhooks rejected.
 */
export class StripeFundingClient {
  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly fetchImpl: typeof fetch;
  readonly creditsPerUsd: bigint;

  constructor(options: StripeClientOptions) {
    if (!options.secretKey.trim()) {
      throw new Error("STRIPE_SECRET_KEY is required for funding");
    }
    if (!options.webhookSecret.trim()) {
      throw new Error("STRIPE_WEBHOOK_SECRET is required for funding");
    }
    this.secretKey = options.secretKey.trim();
    this.webhookSecret = options.webhookSecret.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.creditsPerUsd = options.creditsPerUsd ?? 1_000_000n;
  }

  async createCheckoutSession(
    input: StripeCheckoutInput,
  ): Promise<StripeCheckoutSession> {
    if (!/^\d+$/.test(input.creditAmount) || BigInt(input.creditAmount) <= 0n) {
      throw new StoreError("VALIDATION", "creditAmount must be > 0 atomic", 400);
    }
    if (!Number.isInteger(input.fiatAmountCents) || input.fiatAmountCents < 50) {
      throw new StoreError(
        "VALIDATION",
        "fiatAmountCents must be an integer >= 50",
        400,
      );
    }

    const currency = (input.currency ?? "usd").toLowerCase();
    const body = new URLSearchParams();
    body.set("mode", "payment");
    body.set("success_url", input.successUrl);
    body.set("cancel_url", input.cancelUrl);
    body.set("line_items[0][quantity]", "1");
    body.set("line_items[0][price_data][currency]", currency);
    body.set(
      "line_items[0][price_data][unit_amount]",
      String(input.fiatAmountCents),
    );
    body.set(
      "line_items[0][price_data][product_data][name]",
      `PayMCP Store credits (${input.creditAmount} atomic)`,
    );
    body.set("metadata[buyerId]", input.buyerId);
    body.set("metadata[creditAmount]", input.creditAmount);
    body.set("metadata[purpose]", "paymcp_store_credits");
    if (input.customerEmail !== undefined) {
      body.set("customer_email", input.customerEmail);
    }

    const res = await this.fetchImpl("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new StoreError(
        "INTERNAL",
        `stripe checkout returned non-JSON (HTTP ${res.status})`,
        502,
      );
    }
    if (!res.ok) {
      const msg =
        typeof json === "object" &&
        json !== null &&
        "error" in json &&
        typeof (json as { error?: { message?: unknown } }).error?.message ===
          "string"
          ? (json as { error: { message: string } }).error.message
          : `HTTP ${res.status}`;
      throw new StoreError("INTERNAL", `stripe checkout failed: ${msg}`, 502);
    }
    const id = (json as { id?: unknown }).id;
    const url = (json as { url?: unknown }).url;
    if (typeof id !== "string" || typeof url !== "string") {
      throw new StoreError(
        "INTERNAL",
        "stripe checkout response missing id/url",
        502,
      );
    }
    return { id, url };
  }

  /**
   * Verify Stripe-Signature and parse event. Returns credit instructions when
   * checkout.session.completed with our metadata; otherwise null (ignore).
   */
  parseVerifiedWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
  ): { buyerId: string; creditAmount: string; fundingId: string } | null {
    if (signatureHeader === undefined || signatureHeader.length === 0) {
      throw new StoreError("VALIDATION", "missing Stripe-Signature header", 400);
    }
    verifyStripeSignature(rawBody, signatureHeader, this.webhookSecret);

    let event: unknown;
    try {
      event = JSON.parse(rawBody) as unknown;
    } catch {
      throw new StoreError("VALIDATION", "webhook body must be JSON", 400);
    }
    if (typeof event !== "object" || event === null) {
      throw new StoreError("VALIDATION", "webhook event must be an object", 400);
    }
    const type = (event as { type?: unknown }).type;
    if (type !== "checkout.session.completed") {
      return null;
    }
    const session = (event as { data?: { object?: unknown } }).data?.object;
    if (typeof session !== "object" || session === null) {
      throw new StoreError("VALIDATION", "checkout session missing", 400);
    }
    const paymentStatus = (session as { payment_status?: unknown }).payment_status;
    if (paymentStatus !== "paid" && paymentStatus !== "no_payment_required") {
      return null;
    }
    const id = (session as { id?: unknown }).id;
    const metadata = (session as { metadata?: unknown }).metadata;
    if (typeof id !== "string") {
      throw new StoreError("VALIDATION", "session id missing", 400);
    }
    if (typeof metadata !== "object" || metadata === null) {
      throw new StoreError("VALIDATION", "session metadata missing", 400);
    }
    const purpose = (metadata as { purpose?: unknown }).purpose;
    if (purpose !== "paymcp_store_credits") {
      return null;
    }
    const buyerId = (metadata as { buyerId?: unknown }).buyerId;
    const creditAmount = (metadata as { creditAmount?: unknown }).creditAmount;
    if (typeof buyerId !== "string" || buyerId.length === 0) {
      throw new StoreError("VALIDATION", "metadata.buyerId required", 400);
    }
    if (typeof creditAmount !== "string" || !/^\d+$/.test(creditAmount)) {
      throw new StoreError("VALIDATION", "metadata.creditAmount required", 400);
    }
    return { buyerId, creditAmount, fundingId: `stripe:${id}` };
  }
}

export function verifyStripeSignature(
  rawBody: string,
  header: string,
  secret: string,
  toleranceSec = 300,
): void {
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const [k, ...rest] = p.split("=");
      return [k?.trim() ?? "", rest.join("=")];
    }),
  );
  const t = parts["t"];
  const v1 = parts["v1"];
  if (t === undefined || v1 === undefined) {
    throw new StoreError("VALIDATION", "invalid Stripe-Signature header", 400);
  }
  const ts = Number(t);
  if (!Number.isFinite(ts)) {
    throw new StoreError("VALIDATION", "invalid Stripe signature timestamp", 400);
  }
  const age = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (age > toleranceSec) {
    throw new StoreError("VALIDATION", "Stripe signature timestamp outside tolerance", 400);
  }
  const expected = createHmac("sha256", secret)
    .update(`${t}.${rawBody}`, "utf8")
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(v1, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new StoreError("VALIDATION", "Stripe signature mismatch", 400);
  }
}

/** Map fiat cents (USD) to atomic credits at 6-decimal USDC parity. */
export function creditsForUsdCents(cents: number, creditsPerUsd = 1_000_000n): string {
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new StoreError("VALIDATION", "cents must be a positive integer", 400);
  }
  return ((BigInt(cents) * creditsPerUsd) / 100n).toString();
}
