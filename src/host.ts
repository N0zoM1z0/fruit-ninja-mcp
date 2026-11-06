import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./server.js";
import type { GameRuntime } from "./runtime.js";
import type { Interface, McpProfile } from "./types.js";

/** The evaluator owns the game; an actor disconnect cannot stop its clock. */
export async function hostGame(
  runtime: GameRuntime,
  mode: Interface,
  profile: McpProfile = "standard",
) {
  const mcp = buildServer(runtime, mode, profile);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  await mcp.connect(transport);
  const http = createServer((request, response) => {
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    void transport.handleRequest(request, response).catch((error) => {
      if (!response.headersSent) response.writeHead(500).end(String(error));
      else response.end();
    });
  });
  await new Promise<void>((done, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", done);
  });
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("MCP host did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      await mcp.close();
      http.closeAllConnections();
      await new Promise<void>((done) => http.close(() => done()));
    },
  };
}
