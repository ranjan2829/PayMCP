import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { CompiledOperation } from "../types/openapi.js";
import type { PaymcpEnvConfig } from "../types/config.js";
import type { PriceTable } from "../pricing/resolve.js";
import { isOperationPaid } from "../pricing/resolve.js";
import {
  HEADER_IDEMPOTENCY_KEY,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  encodeHeaderPayload,
  decodeHeaderPayload,
} from "../headers/codec.js";
import { parsePaymentPayload } from "../headers/validate.js";
import {
  FacilitatorSettler,
  FacilitatorHttpError,
  FacilitatorTransportError,
} from "../settler/facilitator.js";
import { buildPaymentRequired, buildResource } from "../settler/challenge.js";
import { deriveIdempotencyKey } from "../ledger/sqlite.js";
import { createLedger } from "../ledger/create.js";
import type { Ledger } from "../ledger/types.js";
import type {
  PaymentAccept,
  PaymentPayload,
  PaymentRequired,
  SettlementResponse,
} from "../types/x402.js";

export interface PaidMcpServerOptions {
  readonly config: PaymcpEnvConfig;
  readonly operations: readonly CompiledOperation[];
  readonly prices: PriceTable;
  readonly upstreamBaseUrl: string;
  /** Tool allowlist; if empty, all paid+free compiled ops are exposed. */
  readonly allowlist?: readonly string[];
  readonly settler?: FacilitatorSettler;
  readonly ledger?: Ledger;
  readonly fetchImpl?: typeof fetch;
}

export async function createPaidMcpServer(
  options: PaidMcpServerOptions,
): Promise<Server> {
  const allow = new Set(
    options.allowlist ?? options.operations.map((o) => o.operationId),
  );
  const ops = options.operations.filter((o) => allow.has(o.operationId));
  const byId = new Map(ops.map((o) => [o.operationId, o]));

  const settler =
    options.settler ??
    new FacilitatorSettler({
      baseUrl: options.config.facilitatorUrl,
      ...(options.config.facilitatorAuthToken !== undefined
        ? { authToken: options.config.facilitatorAuthToken }
        : {}),
      ...(options.config.facilitatorTimeoutMs !== undefined
        ? { timeoutMs: options.config.facilitatorTimeoutMs }
        : {}),
      ...(options.config.facilitatorMaxRetries !== undefined
        ? { maxRetries: options.config.facilitatorMaxRetries }
        : {}),
    });
  const ledger = options.ledger ?? (await createLedger(options.config));
  const fetchImpl = options.fetchImpl ?? fetch;

  const server = new Server(
    { name: "paymcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = ops.map((op) => operationToTool(op, options.prices));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const op = byId.get(name);
    if (op === undefined) {
      return textResult(`Unknown tool: ${name}`, true);
    }
    const args = asArgsRecord(request.params.arguments);

    const paidCheck = isOperationPaid(options.prices, op.operationId);
    if (paidCheck.paid) {
      const payResult = await preparePayment({
        op,
        price: paidCheck.price,
        args,
        config: options.config,
        settler,
        ledger,
        upstreamBaseUrl: options.upstreamBaseUrl,
      });
      if (payResult.kind === "challenge") {
        return textResult(payResult.message, true);
      }
      if (payResult.kind === "error") {
        return textResult(payResult.message, true);
      }

      // Payment verified (or already settled) — call upstream first; settle only on 2xx.
      const upstream = await callUpstream(
        op,
        args,
        options.upstreamBaseUrl,
        fetchImpl,
      );

      if (payResult.priorSettlement !== undefined) {
        return textResult(
          JSON.stringify(
            {
              settlement: payResult.priorSettlement,
              data: upstream.body,
              status: upstream.status,
            },
            null,
            2,
          ),
          upstream.status >= 400,
        );
      }

      const is2xx = upstream.status >= 200 && upstream.status < 300;
      if (!is2xx) {
        await ledger.recordSettlement({
          idempotencyKey: payResult.clientIdem,
          operationId: op.operationId,
          amount: paidCheck.price.amount,
          network: payResult.accept.network,
          payer: "",
          transaction: "",
          status: "failed",
          errorReason: `upstream_http_${upstream.status}`,
        });
        return textResult(
          JSON.stringify(
            {
              error: "upstream_failed",
              data: upstream.body,
              status: upstream.status,
              settlement: null,
            },
            null,
            2,
          ),
          true,
        );
      }

      let settlement: SettlementResponse;
      try {
        settlement = await settler.settle({
          paymentPayload: payResult.paymentPayload,
          paymentRequirements: payResult.accept,
        });
      } catch (err) {
        await ledger.recordSettlement({
          idempotencyKey: payResult.clientIdem,
          operationId: op.operationId,
          amount: paidCheck.price.amount,
          network: payResult.accept.network,
          payer: "",
          transaction: "",
          status: "failed",
          errorReason: "facilitator_unavailable",
        });
        const message =
          err instanceof FacilitatorHttpError ||
          err instanceof FacilitatorTransportError
            ? err.message
            : err instanceof Error
              ? err.message
              : "facilitator_error";
        return textResult(
          JSON.stringify(
            {
              error: "facilitator_unavailable",
              detail: message,
              data: upstream.body,
              status: upstream.status,
            },
            null,
            2,
          ),
          true,
        );
      }

      if (!settlement.success) {
        await ledger.recordSettlement({
          idempotencyKey: payResult.clientIdem,
          operationId: op.operationId,
          amount: paidCheck.price.amount,
          network: settlement.network,
          payer: settlement.payer,
          transaction: settlement.transaction,
          status: "failed",
          ...(settlement.errorReason !== undefined
            ? { errorReason: settlement.errorReason }
            : {}),
        });
        return textResult(
          JSON.stringify(
            {
              error: "payment_failed",
              status: 402,
              reason: settlement.errorReason ?? "settlement_failed",
              headers: {
                [HEADER_PAYMENT_RESPONSE]: encodeHeaderPayload(settlement),
                [HEADER_PAYMENT_REQUIRED]: encodeHeaderPayload(
                  payResult.required,
                ),
              },
            },
            null,
            2,
          ),
          true,
        );
      }

      await ledger.recordSettlement({
        idempotencyKey: payResult.clientIdem,
        operationId: op.operationId,
        amount: paidCheck.price.amount,
        network: settlement.network,
        payer: settlement.payer,
        transaction: settlement.transaction,
        status: "settled",
      });

      return textResult(
        JSON.stringify(
          {
            settlement: {
              success: true as const,
              transaction: settlement.transaction,
              network: settlement.network,
              payer: settlement.payer,
            },
            data: upstream.body,
            status: upstream.status,
          },
          null,
          2,
        ),
        false,
      );
    }

    const upstream = await callUpstream(
      op,
      args,
      options.upstreamBaseUrl,
      fetchImpl,
    );
    return textResult(
      JSON.stringify({ data: upstream.body, status: upstream.status }, null, 2),
      upstream.status >= 400,
    );
  });

  return server;
}

export async function runPaidMcpStdio(
  options: PaidMcpServerOptions,
): Promise<void> {
  const server = await createPaidMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function operationToTool(op: CompiledOperation, prices: PriceTable): Tool {
  const paidCheck = isOperationPaid(prices, op.operationId);
  const priceNote = paidCheck.paid
    ? ` [paid: ${paidCheck.price.amount} atomic units — pass paymentSignature base64 in arguments]`
    : " [free]";
  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];

  for (const p of op.parameters) {
    properties[p.name] = {
      type: p.schema?.type ?? "string",
      description: p.description ?? p.name,
    };
    if (p.required) {
      required.push(p.name);
    }
  }
  if (paidCheck.paid) {
    properties["paymentSignature"] = {
      type: "string",
      description:
        "Base64-encoded x402 PaymentPayload (PAYMENT-SIGNATURE). Omit to receive a 402 challenge JSON.",
    };
    properties["idempotencyKey"] = {
      type: "string",
      description: "Optional idempotency key for settlement ledger replay.",
    };
  }
  properties["body"] = {
    type: "object",
    description: "JSON request body for POST/PUT/PATCH",
  };

  const inputSchema: Tool["inputSchema"] = {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };

  return {
    name: op.operationId,
    description: `${op.summary}${priceNote}`,
    inputSchema,
  };
}

/**
 * Validate payment + early verify. Does NOT settle — settlement happens only
 * after a successful (2xx) upstream/tool result.
 */
async function preparePayment(args: {
  readonly op: CompiledOperation;
  readonly price: {
    readonly amount: string;
    readonly description?: string;
    readonly operationId: string;
  };
  readonly args: Record<string, unknown>;
  readonly config: PaymcpEnvConfig;
  readonly settler: FacilitatorSettler;
  readonly ledger: Ledger;
  readonly upstreamBaseUrl: string;
}): Promise<
  | { kind: "challenge"; message: string }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      paymentPayload: PaymentPayload;
      accept: PaymentAccept;
      required: PaymentRequired;
      clientIdem: string;
      priorSettlement?: {
        success: true;
        transaction: string;
        network: string;
        payer: string;
      };
    }
> {
  const resource = buildResource({
    url: `${args.upstreamBaseUrl}${args.op.path}`,
    description: args.price.description ?? args.op.operationId,
  });
  const required = buildPaymentRequired({
    config: args.config,
    price: args.price,
    resource,
  });
  const accept = required.accepts[0];
  if (accept === undefined) {
    return { kind: "error", message: "misconfigured payment accepts" };
  }

  const sig = args.args["paymentSignature"];
  if (typeof sig !== "string" || sig.length === 0) {
    return {
      kind: "challenge",
      message: JSON.stringify(
        {
          error: "payment_required",
          status: 402,
          headers: {
            [HEADER_PAYMENT_REQUIRED]: encodeHeaderPayload(required),
          },
          paymentRequired: required,
          hint: "Retry the tool with arguments.paymentSignature set to the base64 PAYMENT-SIGNATURE payload after signing.",
        },
        null,
        2,
      ),
    };
  }

  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = decodeHeaderPayload(sig, parsePaymentPayload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid signature";
    return { kind: "error", message: `invalid paymentSignature: ${message}` };
  }

  if (!acceptMatches(paymentPayload.accepted, accept)) {
    return {
      kind: "challenge",
      message: JSON.stringify(
        {
          error: "payment_terms_mismatch",
          status: 402,
          paymentRequired: required,
        },
        null,
        2,
      ),
    };
  }

  const clientIdem =
    typeof args.args["idempotencyKey"] === "string"
      ? args.args["idempotencyKey"]
      : deriveIdempotencyKey({
          operationId: args.op.operationId,
          paymentSignatureHeader: sig,
        });

  // Atomic claim: settled → replay; pending → fail closed; else this caller owns settle.
  const claim = await args.ledger.beginPending({
    idempotencyKey: clientIdem,
    operationId: args.op.operationId,
    amount: args.price.amount,
    network: accept.network,
  });

  if (claim.kind === "already_settled") {
    return {
      kind: "ready",
      paymentPayload,
      accept,
      required,
      clientIdem,
      priorSettlement: {
        success: true,
        transaction: claim.entry.transaction,
        network: claim.entry.network,
        payer: claim.entry.payer,
      },
    };
  }

  if (claim.kind === "in_flight") {
    return {
      kind: "error",
      message: JSON.stringify(
        {
          error: "idempotency_in_flight",
          status: 409,
          detail:
            "A request with this Idempotency-Key is already settling; retry after it completes (settled keys replay without re-charging).",
        },
        null,
        2,
      ),
    };
  }

  let verification;
  try {
    verification = await args.settler.verify({
      paymentPayload,
      paymentRequirements: accept,
    });
  } catch (err) {
    await args.ledger.recordSettlement({
      idempotencyKey: clientIdem,
      operationId: args.op.operationId,
      amount: args.price.amount,
      network: accept.network,
      payer: "",
      transaction: "",
      status: "failed",
      errorReason: "facilitator_unavailable",
    });
    const message =
      err instanceof Error ? err.message : "facilitator_unavailable";
    return { kind: "error", message: `facilitator_unavailable: ${message}` };
  }

  if (!verification.isValid) {
    const reason = verification.invalidReason ?? "payment_invalid";
    await args.ledger.recordSettlement({
      idempotencyKey: clientIdem,
      operationId: args.op.operationId,
      amount: args.price.amount,
      network: accept.network,
      payer: verification.payer ?? "",
      transaction: "",
      status: "failed",
      errorReason: reason,
    });
    return {
      kind: "challenge",
      message: JSON.stringify(
        {
          error: "payment_failed",
          status: 402,
          reason,
          paymentRequired: required,
        },
        null,
        2,
      ),
    };
  }

  return {
    kind: "ready",
    paymentPayload,
    accept,
    required,
    clientIdem,
  };
}

async function callUpstream(
  op: CompiledOperation,
  args: Record<string, unknown>,
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<{ status: number; body: unknown }> {
  let path = op.path;
  const query = new URLSearchParams();
  for (const p of op.parameters) {
    const val = args[p.name];
    if (val === undefined) {
      continue;
    }
    if (p.in === "path") {
      path = path.replace(`{${p.name}}`, encodeURIComponent(String(val)));
    } else if (p.in === "query") {
      query.set(p.name, String(val));
    }
  }
  const qs = query.toString();
  const url = `${baseUrl.replace(/\/$/, "")}${path}${qs.length > 0 ? `?${qs}` : ""}`;
  const method = op.method.toUpperCase();
  const init: RequestInit = { method, headers: { accept: "application/json" } };
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    const body = args["body"];
    init.headers = {
      accept: "application/json",
      "content-type": "application/json",
    };
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let parsed: unknown = text;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

function acceptMatches(got: PaymentAccept, expected: PaymentAccept): boolean {
  return (
    got.scheme === expected.scheme &&
    got.network === expected.network &&
    got.amount === expected.amount &&
    got.asset === expected.asset &&
    got.payTo === expected.payTo
  );
}

function asArgsRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function textResult(text: string, isError: boolean): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

// silence unused import in type-only usage for Idempotency header constant consumers
void HEADER_IDEMPOTENCY_KEY;
void HEADER_PAYMENT_SIGNATURE;
