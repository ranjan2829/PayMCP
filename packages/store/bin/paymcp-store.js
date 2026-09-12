#!/usr/bin/env node
import { runStoreCli } from "../dist/cli/index.js";

runStoreCli(process.argv.slice(2)).catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exitCode = 1;
});
