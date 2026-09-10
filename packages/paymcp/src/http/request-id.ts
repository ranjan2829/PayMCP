import fp from "fastify-plugin";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { newRequestId } from "./logger.js";

export const REQUEST_ID_HEADER = "x-request-id";

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
  }
}

const requestIdPluginImpl: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.decorateRequest("requestId", "");
  app.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers[REQUEST_ID_HEADER];
    const id =
      typeof incoming === "string" && incoming.length > 0
        ? incoming
        : newRequestId();
    request.requestId = id;
    void reply.header(REQUEST_ID_HEADER, id);
  });
};

/** Assigns / echoes `x-request-id` on every request. */
export const requestIdPlugin = fp(requestIdPluginImpl, {
  name: "paymcp-request-id",
  fastify: "5.x",
});
