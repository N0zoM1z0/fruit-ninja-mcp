#!/usr/bin/env node
/** Reproduce the focused REA evidence behind the native offset manifest. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_SHA256 } from "./transport.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const checkout = path.resolve(root, "../rea");
const tools = path.join(checkout, ".codex/toolchains");
const cli = process.env.REA_CLI ?? path.join(checkout, "scripts/rea.mjs");
let node =
  process.env.REA_NODE ?? path.join(tools, "node-v24.18.0-linux-x64/bin/node");
try {
  await access(node);
} catch {
  node = process.execPath;
}
const target = path.join(root, ".local/windows/game/FruitNinja.exe");
if (
  createHash("sha256")
    .update(await readFile(target))
    .digest("hex") !== GAME_SHA256
)
  throw new Error("Target SHA-256 mismatch");
const output = path.join(
  root,
  ".local/windows/evidence",
  "repro-" + new Date().toISOString().replaceAll(":", "-"),
);
await mkdir(output, { recursive: true });
const env = {
  ...process.env,
  REA_ANALYSIS_PROVIDER: "ghidra",
  GHIDRA_INSTALL_DIR:
    process.env.GHIDRA_INSTALL_DIR ?? path.join(tools, "ghidra_12.1.4_PUBLIC"),
  JAVA_HOME: process.env.JAVA_HOME ?? path.join(tools, "jdk-21.0.12.1+1"),
  XDG_CONFIG_HOME: path.join(root, ".local/windows/rea-config"),
  REA_GHIDRA_CHECKPOINT_DIR: path.join(
    root,
    ".local/windows/ghidra-checkpoints",
  ),
};
env.PATH = path.join(env.JAVA_HOME, "bin") + path.delimiter + process.env.PATH;
const client = new Client({
  name: "fruit-ninja-rea-investigation",
  version: "0.1.0",
});
const transport = new StdioClientTransport({
  command: node,
  args: [cli, "--mcp"],
  env,
  stderr: "inherit",
});
const ledger = [];
let sequence = 0,
  opened = false,
  connected = false;
async function call(name, args = {}) {
  const start = Date.now();
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 600000,
  });
  const file = `${String(++sequence).padStart(3, "0")}-${name}.json`;
  await writeFile(path.join(output, file), JSON.stringify(result, null, 2));
  if (result.isError) throw new Error(`${name} failed; see ${file}`);
  const record =
    result.structuredContent ??
    JSON.parse(result.content.find((item) => item.type === "text").text);
  ledger.push({
    operation: name,
    args,
    elapsed_ms: Date.now() - start,
    evidence_id: record.evidence_id ?? record.id ?? null,
    file,
  });
  console.error(`${name} ${args.procedure ?? ""}: ${Date.now() - start} ms`);
  return record;
}
try {
  await client.connect(transport, { timeout: 120000 });
  connected = true;
  const catalog = await client.listTools();
  const names = new Set(catalog.tools.map((tool) => tool.name));
  for (const name of [
    "open_binary",
    "procedure_pseudo_code",
    "export_evidence_bundle",
    "close_binary",
    "reset_investigation",
  ]) {
    if (!names.has(name))
      throw new Error(`Installed REA does not advertise ${name}`);
  }
  await writeFile(
    path.join(output, "schemas.json"),
    JSON.stringify(
      catalog.tools.filter((tool) =>
        [
          "open_binary",
          "procedure_pseudo_code",
          "export_evidence_bundle",
          "close_binary",
          "reset_investigation",
        ].includes(tool.name),
      ),
      null,
      2,
    ),
  );
  await call("open_binary", { path: target, provider_id: "ghidra" });
  opened = true;
  const procedures = process.argv.slice(2).length
    ? process.argv.slice(2)
    : [
        "0x4e7170",
        "0x4e6c20",
        "0x40f3e0",
        "0x4e0b00",
        "0x4e59e0",
        "0x429d20",
        "0x4a5b90",
        "0x50a5b0",
        "0x4925a0",
      ];
  for (const procedure of procedures)
    await call("procedure_pseudo_code", { procedure });
  await call("export_evidence_bundle", {
    path: path.join(output, "evidence.bundle.json"),
  });
} finally {
  try {
    if (opened) await call("close_binary");
    if (connected)
      await call("reset_investigation", {
        save_path: path.join(output, "complete.bundle.json"),
      });
  } finally {
    await writeFile(
      path.join(output, "ledger.json"),
      JSON.stringify(ledger, null, 2),
    );
    await client.close();
  }
}
console.log(
  JSON.stringify({
    output,
    procedures: ledger.filter(
      (item) => item.operation === "procedure_pseudo_code",
    ).length,
  }),
);
