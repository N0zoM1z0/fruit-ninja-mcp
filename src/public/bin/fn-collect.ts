#!/usr/bin/env node
// PUBLIC sandbox helper used by the build tool: serialize /output for freezing on the host.
// Symlinks and special files are rejected here and again by the host validator.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2] ?? "/output";
const files: Record<string, { mode: number; base64: string }> = {};
let size = 0;
const walk = (directory: string) => {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name),
      stat = lstatSync(path);
    if (stat.isDirectory()) walk(path);
    else if (stat.isFile()) {
      size += stat.size;
      if (size > 64 * 1024 * 1024) throw new Error("artifact exceeds 64 MiB");
      files[relative(root, path)] = {
        mode: stat.mode & 0o777,
        base64: readFileSync(path).toString("base64"),
      };
    } else
      throw new Error(
        `symlinks and special files are forbidden: ${relative(root, path)}`,
      );
  }
};
walk(root);
process.stdout.write(JSON.stringify({ files }));
