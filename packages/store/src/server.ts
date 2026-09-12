import { loadStoreEnv } from "./config/env.js";
import { createStoreApp } from "./gateway/app.js";

async function main(): Promise<void> {
  const env = loadStoreEnv();
  const store = await createStoreApp({ env });
  const address = await store.app.listen({
    host: env.STORE_HOST,
    port: env.STORE_PORT,
  });
  store.app.log.info({ address }, "paymcp store listening");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
