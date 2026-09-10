import type { FastifyInstance } from "fastify";
import type { Ledger } from "../ledger/types.js";

export interface HealthOptions {
  readonly ledger?: Ledger;
  /** Extra readiness checks; return false or throw to fail /readyz. */
  readonly readyChecks?: readonly (() => Promise<boolean> | boolean)[];
}

/**
 * Registers GET /healthz (liveness) and GET /readyz (ledger readiness).
 */
export async function registerHealthRoutes(
  app: FastifyInstance,
  options: HealthOptions = {},
): Promise<void> {
  app.get("/healthz", async () => ({
    status: "ok",
    ts: new Date().toISOString(),
  }));

  app.get("/readyz", async (_req, reply) => {
    const checks: Record<string, boolean> = {};
    let ready = true;

    if (options.ledger !== undefined) {
      const ledgerOk = await options.ledger.isReady();
      checks["ledger"] = ledgerOk;
      if (!ledgerOk) ready = false;
    }

    if (options.readyChecks !== undefined) {
      let i = 0;
      for (const check of options.readyChecks) {
        const name = `check_${i}`;
        i += 1;
        try {
          const ok = await check();
          checks[name] = ok;
          if (!ok) ready = false;
        } catch {
          checks[name] = false;
          ready = false;
        }
      }
    }

    if (!ready) {
      return reply.code(503).send({ status: "not_ready", checks });
    }
    return { status: "ready", checks };
  });
}
