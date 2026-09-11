import { z } from "zod";

/**
 * Agent / tool traces for the PayMCP harness quality gate.
 * Aligns with production rules: settle on 2xx only, Idempotency-Key,
 * budgets, and no secrets in logs.
 */

export const TraceEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("http_request"),
    operationId: z.string().min(1),
    method: z.string().min(1).optional(),
    path: z.string().optional(),
    /** Request headers (lower-case keys recommended). */
    headers: z.record(z.string()).optional(),
    amountAtomic: z.string().regex(/^\d+$/).optional(),
  }),
  z.object({
    type: z.literal("http_response"),
    operationId: z.string().min(1),
    statusCode: z.number().int().min(100).max(599),
  }),
  z.object({
    type: z.literal("verify"),
    operationId: z.string().min(1),
    success: z.boolean(),
  }),
  z.object({
    type: z.literal("settle"),
    operationId: z.string().min(1),
    success: z.boolean(),
    amountAtomic: z.string().regex(/^\d+$/).optional(),
    idempotencyKey: z.string().optional(),
    /** Status code of the upstream/handler reply when settle was attempted. */
    afterStatusCode: z.number().int().min(100).max(599).optional(),
  }),
  z.object({
    type: z.literal("budget_check"),
    operationId: z.string().min(1),
    maxDailyAtomic: z.string().regex(/^\d+$/),
    spentAtomic: z.string().regex(/^\d+$/),
    requestedAtomic: z.string().regex(/^\d+$/),
    allowed: z.boolean(),
  }),
  z.object({
    type: z.literal("log"),
    level: z.enum(["debug", "info", "warn", "error"]).optional(),
    message: z.string(),
  }),
]);

export const AgentTraceSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  description: z.string().optional(),
  /** Expected harness outcome for fixture self-checks (optional). */
  expect: z.enum(["pass", "fail"]).optional(),
  events: z.array(TraceEventSchema).min(1),
});

export type TraceEvent = z.infer<typeof TraceEventSchema>;
export type AgentTrace = z.infer<typeof AgentTraceSchema>;

export type PolicyRuleId =
  | "missing_idempotency_key"
  | "settle_before_success"
  | "double_charge"
  | "budget_overrun"
  | "secret_leak";

export interface PolicyViolation {
  readonly rule: PolicyRuleId;
  readonly message: string;
  readonly eventIndex?: number;
}

export interface EvaluateResult {
  readonly ok: boolean;
  readonly traceId: string;
  readonly violations: readonly PolicyViolation[];
}
