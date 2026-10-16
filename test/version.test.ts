import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Engine } from "../src/index";
import { CLIENT_NAME } from "../src/version";

const root = join(import.meta.dir, "..");

// The peer id and client name are derived from package.json
test("peer id and client name match the package version", async () => {
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
  const [major, minor, patch] = version.split(".");
  const engine = new Engine();
  expect(Buffer.from(engine.peerId.subarray(0, 8)).toString()).toBe(`-TT${major}${minor}${patch}0-`);
  expect(CLIENT_NAME).toBe(`tinytorrent ${version}`);
});
