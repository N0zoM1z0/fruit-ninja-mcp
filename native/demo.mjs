#!/usr/bin/env node
/** Scripted MCP client: validates the reused strategy, not an LLM benchmark. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFile, appendFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { openSession } from "./session.mjs";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "max-seconds": { type: "string", default: "180" },
  },
});
const output = path.resolve(
  values.output ??
    `.local/windows/demos/${new Date().toISOString().replaceAll(":", "-")}`,
);
const session = await openSession({ output });
const client = new Client({
  name: "native-fruit-ninja-scripted-demo",
  version: "0.2.0",
});
let calls = 0;
async function call(name, args = {}) {
  const at = performance.now();
  const response = await client.callTool({ name, arguments: args });
  if (response.isError)
    throw new Error(`${name}: ${response.content?.[0]?.text}`);
  const result = JSON.parse(
    response.content.find((c) => c.type === "text").text,
  );
  await appendFile(
    path.join(output, "mcp-calls.jsonl"),
    JSON.stringify({
      call: ++calls,
      name,
      args,
      at_ms: at,
      elapsed_ms: performance.now() - at,
      result,
    }) + "\n",
  );
  return result;
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(session.url)));
  await writeFile(
    path.join(output, "tools.json"),
    JSON.stringify(await client.listTools(), null, 2),
  );
  await call("get_controls");
  await session.start();
  const deadline = Date.now() + Number(values["max-seconds"]) * 1000;
  while (!session.finished && Date.now() < deadline) await call("slice");
  if (!session.finished)
    throw new Error("Scripted client exceeded its wall-time limit");
  const result = await session.waitResult(Number(values["max-seconds"]));
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify({ ...result, scripted: true, calls }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ ...result, output }, null, 2));
} finally {
  await client.close();
  await session.close();
}
