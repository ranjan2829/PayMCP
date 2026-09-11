# demo-api production image (real FacilitatorSettler only)
FROM node:20-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/paymcp/package.json packages/paymcp/
COPY examples/demo-api/package.json examples/demo-api/
COPY examples/buyer/package.json examples/buyer/
RUN pnpm install --frozen-lockfile
COPY packages/paymcp packages/paymcp
COPY examples/demo-api examples/demo-api
COPY examples/buyer examples/buyer
RUN pnpm --filter openapi-to-paymcp build && pnpm --filter @paymcp/demo-api build

FROM node:20-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/examples/demo-api
RUN mkdir -p /app/examples/demo-api/data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
