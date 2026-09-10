import { describe, it, expect } from "vitest";
import { parseOpenApiDocument, compileOperations } from "../../src/compiler/openapi.js";
import {
  buildPriceTable,
  parsePricesFile,
  isOperationPaid,
} from "../../src/pricing/resolve.js";

const SPEC = {
  openapi: "3.0.3",
  info: { title: "t", version: "1" },
  paths: {
    "/echo": {
      post: {
        operationId: "echoMessage",
        "x-paymcp": { amount: "10000" },
      },
    },
    "/free": {
      get: {
        operationId: "freebie",
      },
    },
  },
};

describe("pricing", () => {
  it("reads x-paymcp and prices.yaml overrides", () => {
    const ops = compileOperations(parseOpenApiDocument(SPEC));
    const table = buildPriceTable(
      ops,
      parsePricesFile({
        version: 1,
        operations: [
          { operationId: "echoMessage", amount: "20000" },
          { operationId: "freebie", amount: "0", paid: false },
        ],
      }),
    );
    const paid = isOperationPaid(table, "echoMessage");
    expect(paid.paid).toBe(true);
    if (paid.paid) {
      expect(paid.price.amount).toBe("20000");
    }
    expect(isOperationPaid(table, "freebie").paid).toBe(false);
  });
});
