// PRIVATE: provenance for every run: code commit, images, game hashes, endpoint (no secrets).
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadGame, packagedGame, root, sha256, upstream } from "../upstream.js";
import { imageIds, run } from "./sandbox.js";

export async function provenance(extra: Record<string, unknown> = {}) {
  const git = async (...args: string[]) => {
    const result = await run("git", ["-C", root, ...args]).catch(() => null);
    return result?.exit_code === 0 ? result.stdout.trim() : null;
  };
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  return {
    schema_version: 1,
    created_at: new Date().toISOString(),
    repository: {
      name: pkg.name,
      version: pkg.version,
      commit: await git("rev-parse", "HEAD"),
      dirty:
        ((await git("status", "--porcelain", "--untracked-files=no")) ?? "") !==
        "",
    },
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    upstream,
    packaged_game_sha256: sha256(packagedGame(await loadGame())),
    images: await imageIds().catch(() => null),
    argv: process.argv.slice(1),
    ...extra,
  };
}
