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
import { FacilitatorSettler } from "../settler/facilitator.js";
import { buildPaymentRequired, buildResource } from "../settler/challenge.js";
import { deriveIdempotencyKey } from "../ledger/sqlite.js";
import { createLedger } from "../ledger/create.js";
import type { Ledger } from "../ledger/types.js";
import type { PaymentAccept } from "../types/x402.js";

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
      const payResult = await enforcePayment({
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
      // settled — fall through to upstream call, attach settlement meta
      const upstream = await callUpstream(op, args, options.upstreamBaseUrl, fetchImpl);
      return textResult(
        JSON.stringify(
          {
            settlement: payResult.settlement,
            data: upstream.body,
            status: upstream.status,
          },
          null,
          2,
        ),
        upstream.status >= 400,
      );
    }

    const upstream = await callUpstream(op, args, options.upstreamBaseUrl, fetchImpl);
    return textResult(
      JSON.stringify({ data: upstream.body, status: upstream.status }, null, 2),
      upstream.status >= 400,
    );
  });

  return server;
}

export async function runPaidMcpStdio(options: PaidMcpServerOptions): Promise<void> {
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

async function enforcePayment(args: {
  readonly op: CompiledOperation;
  readonly price: { readonly amount: string; readonly description?: string; readonly operationId: string };
  readonly args: Record<string, unknown>;
  readonly config: PaymcpEnvConfig;
  readonly settler: FacilitatorSettler;
  readonly ledger: Ledger;
  readonly upstreamBaseUrl: string;
}): Promise<
  | { kind: "challenge"; message: string }
  | { kind: "error"; message: string }
  | {
      kind: "settled";
      settlement: {
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

  let paymentPayload;
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

  const existing = await args.ledger.findByIdempotencyKey(clientIdem);
  if (existing !== undefined && existing.status === "settled") {
    return {
      kind: "settled",
      settlement: {
        success: true,
        transaction: existing.transaction,
        network: existing.network,
        payer: existing.payer,
      },
    };
  }

  const settlement = await args.settler.verifyAndSettle({
    paymentPayload,
    paymentRequirements: accept,
  });

  if (!settlement.success) {
    await args.ledger.recordSettlement({
      idempotencyKey: clientIdem,
      operationId: args.op.operationId,
      amount: args.price.amount,
      network: settlement.network,
      payer: settlement.payer,
      transaction: settlement.transaction,
      status: "failed",
      ...(settlement.errorReason !== undefined
        ? { errorReason: settlement.errorReason }
        : {}),
    });
    return {
      kind: "challenge",
      message: JSON.stringify(
        {
          error: "payment_failed",
          status: 402,
          reason: settlement.errorReason ?? "settlement_failed",
          headers: {
            [HEADER_PAYMENT_RESPONSE]: encodeHeaderPayload(settlement),
            [HEADER_PAYMENT_REQUIRED]: encodeHeaderPayload(required),
          },
        },
        null,
        2,
      ),
    };
  }

  await args.ledger.recordSettlement({
    idempotencyKey: clientIdem,
    operationId: args.op.operationId,
    amount: args.price.amount,
    network: settlement.network,
    payer: settlement.payer,
    transaction: settlement.transaction,
    status: "settled",
  });

  return {
    kind: "settled",
    settlement: {
      success: true,
      transaction: settlement.transaction,
      network: settlement.network,
      payer: settlement.payer,
    },
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
