import { readFileSync } from "node:fs";
import YAML from "js-yaml";
import type {
  CompiledOperation,
  HttpMethod,
  OpenApiDocument,
  OpenApiOperation,
  OpenApiPathItem,
} from "../types/openapi.js";
import { parseXPaymcpExtension } from "../pricing/resolve.js";
import { isRecord } from "../headers/codec.js";

const METHODS: readonly HttpMethod[] = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
];

export function loadOpenApi(path: string): OpenApiDocument {
  const text = readFileSync(path, "utf8");
  const raw = path.endsWith(".json")
    ? (JSON.parse(text) as unknown)
    : (YAML.load(text) as unknown);
  return parseOpenApiDocument(raw);
}

export function parseOpenApiDocument(raw: unknown): OpenApiDocument {
  if (!isRecord(raw)) {
    throw new Error("OpenAPI document must be an object");
  }
  const openapi = raw["openapi"];
  if (typeof openapi !== "string" || !openapi.startsWith("3.")) {
    throw new Error("Only OpenAPI 3.x is supported");
  }
  const infoRaw = raw["info"];
  if (!isRecord(infoRaw)) {
    throw new Error("info is required");
  }
  const title = infoRaw["title"];
  const version = infoRaw["version"];
  if (typeof title !== "string" || typeof version !== "string") {
    throw new Error("info.title and info.version are required strings");
  }
  const pathsRaw = raw["paths"];
  if (!isRecord(pathsRaw)) {
    throw new Error("paths is required");
  }
  const paths: Record<string, OpenApiPathItem> = {};
  for (const [pathKey, pathVal] of Object.entries(pathsRaw)) {
    paths[pathKey] = parsePathItem(pathVal, pathKey);
  }
  const doc: OpenApiDocument = {
    openapi,
    info: {
      title,
      version,
      ...(typeof infoRaw["description"] === "string"
        ? { description: infoRaw["description"] }
        : {}),
    },
    paths,
  };
  const servers = raw["servers"];
  if (Array.isArray(servers)) {
    const parsedServers = servers
      .map((s) => {
        if (!isRecord(s) || typeof s["url"] !== "string") {
          return undefined;
        }
        return {
          url: s["url"],
          ...(typeof s["description"] === "string"
            ? { description: s["description"] }
            : {}),
        };
      })
      .filter((s): s is { url: string; description?: string } => s !== undefined);
    return { ...doc, servers: parsedServers };
  }
  return doc;
}

function parsePathItem(raw: unknown, pathKey: string): OpenApiPathItem {
  if (!isRecord(raw)) {
    throw new Error(`paths.${pathKey} must be an object`);
  }
  const item: {
    summary?: string;
    description?: string;
    get?: OpenApiOperation;
    post?: OpenApiOperation;
    put?: OpenApiOperation;
    patch?: OpenApiOperation;
    delete?: OpenApiOperation;
    head?: OpenApiOperation;
    options?: OpenApiOperation;
  } = {};
  if (typeof raw["summary"] === "string") {
    item.summary = raw["summary"];
  }
  if (typeof raw["description"] === "string") {
    item.description = raw["description"];
  }
  for (const method of METHODS) {
    const opRaw = raw[method];
    if (opRaw === undefined) {
      continue;
    }
    item[method] = parseOperation(opRaw, `${pathKey}.${method}`);
  }
  return item;
}

function parseOperation(raw: unknown, label: string): OpenApiOperation {
  if (!isRecord(raw)) {
    throw new Error(`${label} must be an object`);
  }
  const op: OpenApiOperation = {};
  const withId: OpenApiOperation =
    typeof raw["operationId"] === "string"
      ? { ...op, operationId: raw["operationId"] }
      : op;
  const withSummary: OpenApiOperation =
    typeof raw["summary"] === "string"
      ? { ...withId, summary: raw["summary"] }
      : withId;
  const withDesc: OpenApiOperation =
    typeof raw["description"] === "string"
      ? { ...withSummary, description: raw["description"] }
      : withSummary;
  let current: OpenApiOperation = withDesc;
  if (Array.isArray(raw["tags"])) {
    current = {
      ...current,
      tags: raw["tags"].filter((t): t is string => typeof t === "string"),
    };
  }
  const ext = parseXPaymcpExtension(raw["x-paymcp"]);
  if (ext !== undefined) {
    current = { ...current, "x-paymcp": ext };
  }
  if (Array.isArray(raw["parameters"])) {
    current = {
      ...current,
      parameters: raw["parameters"] as NonNullable<OpenApiOperation["parameters"]>,
    };
  }
  if (isRecord(raw["requestBody"])) {
    current = {
      ...current,
      requestBody: raw["requestBody"] as NonNullable<OpenApiOperation["requestBody"]>,
    };
  }
  return current;
}

export function compileOperations(doc: OpenApiDocument): CompiledOperation[] {
  const out: CompiledOperation[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (op === undefined) {
        continue;
      }
      const operationId =
        op.operationId ??
        `${method}_${path.replace(/[^\w]+/g, "_").replace(/^_|_$/g, "")}`;
      const ext = op["x-paymcp"];
      out.push({
        operationId,
        method,
        path,
        summary: op.summary ?? operationId,
        description: op.description ?? op.summary ?? "",
        parameters: op.parameters ?? [],
        requestBody: op.requestBody,
        amount: ext?.amount,
        paid: ext?.paid !== false && ext?.amount !== undefined,
      });
    }
  }
  return out;
}

export function defaultUpstreamBase(doc: OpenApiDocument): string {
  const first = doc.servers?.[0]?.url;
  if (first !== undefined && first.length > 0) {
    return first.replace(/\/$/, "");
  }
  return "http://127.0.0.1:8787";
}
