import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import {
  paymcpPaywall,
  loadConfigFromEnv,
  loadOpenApi,
  compileOperations,
  buildPriceTable,
  loadPricesFile,
  FacilitatorSettler,
  createLedger,
  requestIdPlugin,
  registerHealthRoutes,
  type Ledger,
} from "openapi-to-paymcp";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

export interface DemoServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly config?: ReturnType<typeof loadConfigFromEnv>;
  readonly settler?: FacilitatorSettler;
  readonly ledger?: Ledger;
  readonly ledgerPath?: string;
  readonly skipPaywall?: boolean;
}

export async function buildDemoServer(options: DemoServerOptions = {}) {
  const app = Fastify({
    logger: options.skipPaywall
      ? false
      : {
          level: process.env["LOG_LEVEL"] ?? "info",
          redact: {
            paths: [
              'req.headers["payment-signature"]',
              'req.headers["PAYMENT-SIGNATURE"]',
              "req.headers.authorization",
            ],
            censor: "[REDACTED]",
          },
        },
    requestIdHeader: "x-request-id",
  });

  await app.register(requestIdPlugin);

  const openapiPath = join(root, "openapi.yaml");
  const pricesPath = join(root, "prices.yaml");
  const doc = loadOpenApi(openapiPath);
  const operations = compileOperations(doc);
  const prices = buildPriceTable(operations, loadPricesFile(pricesPath));

  let ledger: Ledger | undefined;

  if (!options.skipPaywall) {
    const config = options.config ?? loadConfigFromEnv();
    ledger =
      options.ledger ??
      (await createLedger({
        ...(config.databaseUrl !== undefined
          ? { databaseUrl: config.databaseUrl }
          : {}),
        ledgerPath:
          options.ledgerPath ??
          config.ledgerPath ??
          join(root, "demo-ledger.db"),
      }));
    const settler =
      options.settler ??
      new FacilitatorSettler({
        baseUrl: config.facilitatorUrl,
        ...(config.facilitatorAuthToken !== undefined
          ? { authToken: config.facilitatorAuthToken }
          : {}),
        ...(config.facilitatorTimeoutMs !== undefined
          ? { timeoutMs: config.facilitatorTimeoutMs }
          : {}),
        ...(config.facilitatorMaxRetries !== undefined
          ? { maxRetries: config.facilitatorMaxRetries }
          : {}),
      });

    await app.register(paymcpPaywall, {
      config,
      prices,
      settler,
      ledger,
      publicBaseUrl: `http://127.0.0.1:${options.port ?? 8787}`,
      operationIdForRequest: (req: FastifyRequest) => {
        const path = req.url.split("?")[0] ?? "";
        if (req.method === "GET" && path === "/health") return "health";
        if (req.method === "POST" && path === "/echo") return "echoMessage";
        if (req.method === "GET" && path === "/weather") return "getWeather";
        return undefined;
      },
    });
  }

  await registerHealthRoutes(app, {
    ...(ledger !== undefined ? { ledger } : {}),
  });

  app.get("/health", async () => ({ ok: true }));

  app.post<{ Body: { message?: string } }>("/echo", async (req, reply) => {
    const message = req.body?.message;
    if (typeof message !== "string") {
      return reply.code(400).send({ error: "message required" });
    }
    return { echo: message, ts: new Date().toISOString() };
  });

  app.get<{ Querystring: { city?: string } }>("/weather", async (req, reply) => {
    const city = req.query.city;
    if (typeof city !== "string" || city.length === 0) {
      return reply.code(400).send({ error: "city required" });
    }
    const hash = createHash("sha256").update(city.toLowerCase()).digest();
    const tempC = (hash[0]! % 35) - 5;
    const conditions = ["clear", "clouds", "rain", "wind"] as const;
    const condition = conditions[hash[1]! % conditions.length]!;
    return {
      city,
      tempC,
      condition,
      source: "demo-stub",
    };
  });

  return app;
}

async function main(): Promise<void> {
  const port = Number.parseInt(process.env["PORT"] ?? "8787", 10);
  const host = process.env["HOST"] ?? "0.0.0.0";
  const app = await buildDemoServer({ port });
  await app.listen({ port, host });
  app.log.info(`demo-api listening on http://${host}:${port}`);
}

const isDirect =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirect) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  });
}
