#!/usr/bin/env node
// PUBLIC builder tool: talk to your own stdio MCP server for testing.
//   fn-mcp list -- /output/mcp/launch.sh
//   fn-mcp call TOOL '{"json":"arguments"}' [TOOL2 '{...}' ...] -- /output/mcp/launch.sh
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
if (split < 1 || split === argv.length - 1) {
  console.error("usage: fn-mcp list|call [TOOL JSON]... -- COMMAND [ARGS...]");
  process.exit(2);
}
const [op, ...calls] = argv.slice(0, split);
const [command, ...args] = argv.slice(split + 1);
const client = new Client({ name: "fn-mcp", version: "1" });
await client.connect(
  new StdioClientTransport({
    command,
    args,
    env: process.env as Record<string, string>,
    stderr: "inherit",
  }),
);
try {
  if (op === "list")
    console.log(JSON.stringify(await client.listTools(), null, 1));
  else if (op === "call")
    for (let i = 0; i < calls.length; i += 2) {
      const started = performance.now();
      const result = await client.callTool({
        name: calls[i],
        arguments: JSON.parse(calls[i + 1] ?? "{}"),
      });
      console.log(
        JSON.stringify({
          tool: calls[i],
          duration_ms: Math.round(performance.now() - started),
          result,
        }),
      );
    }
  else throw new Error(`unknown operation ${op}`);
} finally {
  await client.close();
}
