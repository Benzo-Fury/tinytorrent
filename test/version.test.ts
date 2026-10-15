import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Engine } from "../src/index";

const root = join(import.meta.dir, "..");

// The version is hard-coded in the peer id and the client name; both must follow package.json
test("peer id and client name match the package version", async () => {
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
  const [major, minor, patch] = version.split(".");
  const engine = new Engine();
  expect(Buffer.from(engine.peerId.subarray(0, 8)).toString()).toBe(`-TT${major}${minor}${patch}0-`);
  expect(await readFile(join(root, "src/torrent.ts"), "utf8")).toContain(`const CLIENT = "tinytorrent ${version}";`);
});
