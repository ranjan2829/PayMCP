import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, defaultFixturesRoot } from "../src/cli.js";

const fixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

describe("runCli", () => {
  it("defaultFixturesRoot points at package fixtures", () => {
    expect(defaultFixturesRoot()).toContain(`${path.sep}fixtures`);
  });

  it("exits 0 on --help", async () => {
    expect(await runCli(["--help"])).toBe(0);
  });

  it("exits 0 on --list-rules", async () => {
    expect(await runCli(["--list-rules"])).toBe(0);
  });

  it("exits 0 for fixture suite", async () => {
    expect(await runCli(["--fixtures", fixturesRoot])).toBe(0);
  });

  it("exits 1 for a bad --file trace", async () => {
    const file = path.join(fixturesRoot, "bad", "secret-leak.json");
    expect(await runCli(["--file", file])).toBe(1);
  });

  it("exits 0 for a good --file trace", async () => {
    const file = path.join(fixturesRoot, "good", "budget-ok.json");
    expect(await runCli(["--file", file])).toBe(0);
  });
});
