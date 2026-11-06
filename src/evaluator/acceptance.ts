// PRIVATE: smoke a frozen MCP in a FRESH play sandbox against a fresh PUBLIC game (no referee):
// inventory re-hash, adapter load, initialize, tools/list, strict stdout and interface policy.
// Passing smoke is not evidence that the tools work; gameplay is judged by the play audit.
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { browserExecutable } from "../runtime.js";
import { loadGame, packagedGame } from "../upstream.js";
import { DevGame } from "../public/devgame.js";
import { startPort } from "../public/port.js";
import { verifyFrozen } from "./freeze.js";
import { interfacePolicy, type PolicyResult } from "./policy.js";
import {
  newRunId,
  playArgs,
  removeRunContainers,
  socketDir,
} from "./sandbox.js";
import { StrictStdioTransport } from "./stdio.js";

export interface SmokeResult {
  status: "pass" | "fail";
  artifact: string | null;
  reasons: string[];
  tools: { name: string; description?: string }[];
  policy: PolicyResult | null;
  adapter_exports: string[];
  stdout_violations: string[];
  stderr_tail: string;
  stdio_tail: string;
  duration_ms: number;
}
const tail = async (path: string, bytes = 4000) => {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.length > bytes ? text.slice(-bytes) : text;
};
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]);
}

export async function smoke(
  frozenRoot: string,
  workDir: string,
): Promise<SmokeResult> {
  const started = performance.now();
  await mkdir(workDir, { recursive: true });
  const result: SmokeResult = {
    status: "fail",
    artifact: null,
    reasons: [],
    tools: [],
    policy: null,
    adapter_exports: [],
    stdout_violations: [],
    stderr_tail: "",
    stdio_tail: "",
    duration_ms: 0,
  };
  const runId = newRunId("s");
  let game: DevGame | undefined;
  let port: Awaited<ReturnType<typeof startPort>> | undefined;
  let client: Client | undefined;
  let transport: StrictStdioTransport | undefined;
  try {
    const record = await verifyFrozen(frozenRoot);
    result.artifact = record.sha256;
    let adapterSource: string | undefined;
    if (record.adapter)
      adapterSource = await readFile(
        resolve(frozenRoot, record.adapter.path),
        "utf8",
      );
    try {
      game = await DevGame.launch({
        html: packagedGame(await loadGame()),
        executablePath: await browserExecutable(),
        adapterSource,
      });
      result.adapter_exports = game.exports;
    } catch (error) {
      result.reasons.push(
        `adapter_load_error:${String(error instanceof Error ? error.message : error).slice(0, 300)}`,
      );
      throw error;
    }
    const sockets = await socketDir(runId);
    port = await startPort({
      socketPath: resolve(sockets, "port.sock"),
      backend: game,
    });
    transport = new StrictStdioTransport(
      "docker",
      playArgs(runId, resolve(frozenRoot, "mcp"), sockets),
      resolve(workDir, "stdio.jsonl"),
      resolve(workDir, "stderr.log"),
    );
    client = new Client({ name: "fnsm-smoke", version: "1" });
    await withTimeout(client.connect(transport), 30_000, "initialize");
    const tools = (await withTimeout(client.listTools(), 15_000, "tools/list"))
      .tools;
    result.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
    }));
    result.policy = interfacePolicy(tools, record.manifest);
    result.reasons.push(...result.policy.reasons.map((r) => `interface:${r}`));
  } catch (error) {
    if (!result.reasons.length)
      result.reasons.push(
        `error:${String(error instanceof Error ? error.message : error).slice(0, 300)}`,
      );
  } finally {
    result.stdout_violations = transport?.violations ?? [];
    if (result.stdout_violations.length)
      result.reasons.push("stdout_not_json_rpc");
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    await port?.close().catch(() => {});
    await game?.close().catch(() => {});
    await removeRunContainers(runId).catch(() => {});
    result.stderr_tail = await tail(resolve(workDir, "stderr.log"));
    result.stdio_tail = await tail(resolve(workDir, "stdio.jsonl"));
  }
  result.status = result.reasons.length === 0 ? "pass" : "fail";
  result.duration_ms = Math.round(performance.now() - started);
  return result;
}
