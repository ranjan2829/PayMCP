#!/usr/bin/env node
import { runCli } from "../dist/cli.js";

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`paymcp-harness-ci: ${message}`);
    process.exit(1);
  },
);
