import { describe, it, expect } from "vitest";
import { evaluateTrace } from "../src/rules.js";
import type { AgentTrace } from "../src/schema.js";

function trace(
  id: string,
  events: AgentTrace["events"],
): AgentTrace {
  return { version: 1, id, events };
}

describe("evaluateTrace policies", () => {
  it("passes a clean settle-after-200 flow", () => {
    const violations = evaluateTrace(
      trace("t1", [
        {
          type: "http_request",
          operationId: "echo",
          amountAtomic: "1",
          headers: { "idempotency-key": "k1" },
        },
        { type: "http_response", operationId: "echo", statusCode: 200 },
        {
          type: "settle",
          operationId: "echo",
          success: true,
          idempotencyKey: "k1",
          afterStatusCode: 200,
        },
      ]),
    );
    expect(violations).toEqual([]);
  });

  it("flags missing Idempotency-Key on paid request and settle", () => {
    const violations = evaluateTrace(
      trace("t2", [
        {
          type: "http_request",
          operationId: "echo",
          amountAtomic: "1",
          headers: {},
        },
        { type: "http_response", operationId: "echo", statusCode: 200 },
        {
          type: "settle",
          operationId: "echo",
          success: true,
          afterStatusCode: 200,
        },
      ]),
    );
    const rules = violations.map((v) => v.rule);
    expect(rules).toContain("missing_idempotency_key");
    expect(violations.filter((v) => v.rule === "missing_idempotency_key").length).toBeGreaterThanOrEqual(2);
  });

  it("flags settle after non-2xx", () => {
    const violations = evaluateTrace(
      trace("t3", [
        {
          type: "http_request",
          operationId: "echo",
          amountAtomic: "1",
          headers: { "Idempotency-Key": "k" },
        },
        { type: "http_response", operationId: "echo", statusCode: 500 },
        {
          type: "settle",
          operationId: "echo",
          success: false,
          idempotencyKey: "k",
          afterStatusCode: 500,
        },
      ]),
    );
    expect(violations.some((v) => v.rule === "settle_before_success")).toBe(true);
  });

  it("flags settle with no prior response", () => {
    const violations = evaluateTrace(
      trace("t4", [
        {
          type: "settle",
          operationId: "echo",
          success: true,
          idempotencyKey: "k",
        },
      ]),
    );
    expect(violations.some((v) => v.rule === "settle_before_success")).toBe(true);
  });

  it("flags double successful settle on same key", () => {
    const violations = evaluateTrace(
      trace("t5", [
        { type: "http_response", operationId: "echo", statusCode: 200 },
        {
          type: "settle",
          operationId: "echo",
          success: true,
          idempotencyKey: "dup",
          afterStatusCode: 200,
        },
        { type: "http_response", operationId: "echo", statusCode: 200 },
        {
          type: "settle",
          operationId: "echo",
          success: true,
          idempotencyKey: "dup",
          afterStatusCode: 200,
        },
      ]),
    );
    expect(violations.some((v) => v.rule === "double_charge")).toBe(true);
  });

  it("flags budget overrun when allowed=true over max", () => {
    const violations = evaluateTrace(
      trace("t6", [
        {
          type: "budget_check",
          operationId: "echo",
          maxDailyAtomic: "10",
          spentAtomic: "8",
          requestedAtomic: "5",
          allowed: true,
        },
      ]),
    );
    expect(violations.some((v) => v.rule === "budget_overrun")).toBe(true);
  });

  it("does not flag denied budget that would exceed", () => {
    const violations = evaluateTrace(
      trace("t7", [
        {
          type: "budget_check",
          operationId: "echo",
          maxDailyAtomic: "10",
          spentAtomic: "8",
          requestedAtomic: "5",
          allowed: false,
        },
      ]),
    );
    expect(violations).toEqual([]);
  });

  it("flags secret leak in log messages", () => {
    const violations = evaluateTrace(
      trace("t8", [
        {
          type: "log",
          message:
            "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payloadsig",
        },
      ]),
    );
    expect(violations.some((v) => v.rule === "secret_leak")).toBe(true);
  });

  it("flags unredacted payment-signature header", () => {
    const violations = evaluateTrace(
      trace("t9", [
        {
          type: "http_request",
          operationId: "echo",
          headers: {
            "payment-signature": "eyJhbGciOiJFUzI1NiJ9.aaaaaaaaaaaaaaaa",
          },
        },
      ]),
    );
    expect(violations.some((v) => v.rule === "secret_leak")).toBe(true);
  });

  it("allows redacted payment-signature header", () => {
    const violations = evaluateTrace(
      trace("t10", [
        {
          type: "http_request",
          operationId: "echo",
          headers: { "payment-signature": "[REDACTED]" },
        },
        { type: "log", message: "ok PAYMENT-SIGNATURE=[REDACTED]" },
      ]),
    );
    expect(violations.filter((v) => v.rule === "secret_leak")).toEqual([]);
  });
});
