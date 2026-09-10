#!/usr/bin/env node
import { runCli } from "../dist/cli/index.js";

runCli(process.argv.slice(2)).catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`paymcp: ${message}`);
  process.exit(1);
});
