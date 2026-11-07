// Build the packaged game, the minimal builder/play image contexts, and scan them.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assembleContexts,
  scanTree,
  writePackage,
} from "../src/evaluator/package.js";

const pkg = await writePackage();
const contexts = await assembleContexts();
const scans = [
  await scanTree(resolve(contexts, "builder")),
  await scanTree(resolve(contexts, "play")),
];
const report = { package: pkg.manifest.packaged, scans };
await writeFile(
  resolve(contexts, "scan.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (scans.some((s) => s.hits.length)) {
  console.error("Private material found in an agent-visible image context.");
  process.exitCode = 1;
}
