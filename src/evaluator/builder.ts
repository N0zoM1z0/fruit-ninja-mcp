// PRIVATE: builder controller (outside the sandbox) and builder runner. The builder receives the
// packaged game and these exploration/handoff tools only. No gameplay MCP, referee or secret
// is mounted into its sandbox; credentials stay in this host process.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { root } from "../upstream.js";
import { freeze, type Bundle, type FrozenRecord } from "./freeze.js";
import { smoke, type SmokeResult } from "./acceptance.js";
import { runAgent, type AgentResult, type LlmEndpoint } from "./llm.js";
import { provenance } from "./provenance.js";
import { BuilderSandbox, newRunId } from "./sandbox.js";
import { type Handoff, verifyHandoff } from "./handoff.js";

export type { Handoff } from "./handoff.js";
const ok = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});
const fail = (error: unknown): CallToolResult => ({
  isError: true,
  content: [
    {
      type: "text",
      text: error instanceof Error ? error.message : String(error),
    },
  ],
});
function outputPath(path: string): string {
  const normal = posix.normalize(path);
  if (
    typeof path !== "string" ||
    !normal.startsWith("/output/") ||
    normal.includes("\0") ||
    normal !== path
  )
    throw new Error(
      "write_file is restricted to normalized paths under /output/",
    );
  return normal;
}

export class BuilderController {
  readonly frozen = new Map<string, { root: string; record: FrozenRecord }>();
  readonly smoked = new Map<string, SmokeResult>();
  handoff: Handoff | null = null;
  private smokes = 0;
  constructor(
    readonly sandbox: BuilderSandbox,
    readonly output: string,
  ) {}
  exec(argv: string[], timeout_ms?: number, cwd?: string, stdin?: string) {
    if (
      cwd !== undefined &&
      !/^\/(work|output|tmp)(\/|$)/.test(posix.normalize(cwd))
    )
      throw new Error("cwd must be under /work, /output or /tmp");
    return this.sandbox.exec(argv, {
      timeoutMs: timeout_ms,
      cwd,
      input: stdin,
    });
  }
  async readFile(path: string, max_bytes = 262_144) {
    const result = await this.sandbox.exec(
      ["head", "-c", String(Math.min(max_bytes, 1_048_576)), path],
      { maxBytes: 2 * 1_048_576 },
    );
    if (result.exit_code !== 0)
      throw new Error(result.stderr.trim() || `read failed: ${path}`);
    return {
      path,
      bytes: Buffer.byteLength(result.stdout),
      content: result.stdout,
    };
  }
  async writeFile(
    path: string,
    content: string,
    encoding: "utf8" | "base64",
    executable: boolean,
  ) {
    const target = outputPath(path);
    const data =
      encoding === "base64"
        ? Buffer.from(content, "base64")
        : Buffer.from(content, "utf8");
    const result = await this.sandbox.exec(
      [
        "sh",
        "-c",
        'mkdir -p "$(dirname "$1")" && base64 -d > "$1" && chmod "$2" "$1"',
        "sh",
        target,
        executable ? "755" : "644",
      ],
      { input: data.toString("base64") },
    );
    if (result.exit_code !== 0)
      throw new Error(result.stderr.trim() || "write failed");
    return {
      path: target,
      bytes: data.length,
      mode: executable ? "0755" : "0644",
    };
  }
  inspect(op: string, args: string[], file = "/opt/target/game/index.html") {
    return this.sandbox.exec(
      ["node", "/opt/toolchain/fn/bin/fn-inspect.js", op, file, ...args],
      { timeoutMs: 60_000 },
    );
  }
  async build() {
    const collected = await this.sandbox.exec(
      ["node", "/opt/toolchain/fn/bin/fn-collect.js", "/output"],
      { maxBytes: 96 * 1024 * 1024, timeoutMs: 120_000 },
    );
    if (collected.exit_code !== 0)
      throw new Error(collected.stderr.trim() || "collect failed");
    const bundle = JSON.parse(collected.stdout) as Bundle;
    const { root: frozenRoot, record } = await freeze(
      bundle,
      resolve(this.output, "frozen"),
    );
    this.frozen.set(record.sha256, { root: frozenRoot, record });
    return {
      sha256: record.sha256,
      files: Object.keys(record.files).length,
      tools: record.manifest.tools.map((t) => t.name),
      adapter: record.adapter,
    };
  }
  async smoke(sha: string) {
    const entry = this.frozen.get(sha);
    if (!entry) throw new Error("unknown frozen artifact; call build first");
    const result = await smoke(
      entry.root,
      resolve(this.output, `smoke-${++this.smokes}`),
    );
    this.smoked.set(sha, result);
    return result;
  }
  async handoffArtifact(sha: string, notes?: string) {
    const entry = this.frozen.get(sha);
    const smoked = this.smoked.get(sha);
    if (!entry) throw new Error("unknown frozen artifact");
    if (!smoked || smoked.status !== "pass")
      throw new Error(
        "handoff requires a passing smoke of this exact artifact",
      );
    const handoff: Handoff = {
      sha256: sha,
      frozen: entry.root,
      smoke: smoked,
      notes: notes ?? null,
      builder_run: this.output,
      handed_off_at: new Date().toISOString(),
    };
    await verifyHandoff(handoff);
    this.handoff = handoff;
    await writeFile(
      resolve(this.output, "handoff.json"),
      JSON.stringify(this.handoff, null, 2) + "\n",
    );
    return {
      handoff: "recorded",
      sha256: sha,
      note: "Session complete. Your MCP will be deployed as frozen.",
    };
  }
  server(): McpServer {
    const server = new McpServer({
      name: "builder-controller",
      version: "0.3.0",
    });
    const tool = <S extends z.ZodRawShape>(
      name: string,
      description: string,
      shape: S,
      handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
    ) =>
      server.registerTool<z.ZodRawShape, z.ZodObject<S>>(
        name,
        { description, inputSchema: z.object(shape).strict() },
        async (args: any) => {
          try {
            return ok(await handler(args));
          } catch (error) {
            return fail(error);
          }
        },
      );
    tool(
      "exec",
      "Run a command (argv array, no shell unless you invoke one) inside your offline sandbox as an unprivileged user. Long commands must finish within timeout_ms (max 600000).",
      {
        argv: z.array(z.string()).min(1).max(256),
        timeout_ms: z.number().int().min(1000).max(600_000).optional(),
        cwd: z.string().optional(),
        stdin: z.string().max(1_048_576).optional(),
      },
      ({ argv, timeout_ms, cwd, stdin }) =>
        this.exec(argv, timeout_ms, cwd, stdin),
    );
    tool(
      "read_file",
      "Read up to max_bytes (default 256 KiB, max 1 MiB) of a file inside the sandbox.",
      {
        path: z.string().min(1),
        max_bytes: z.number().int().min(1).max(1_048_576).optional(),
      },
      ({ path, max_bytes }) => this.readFile(path, max_bytes),
    );
    tool(
      "write_file",
      "Write a file under /output/ (your deliverable). encoding utf8 or base64; executable sets mode 0755, else 0644.",
      {
        path: z.string().min(1),
        content: z.string().max(16 * 1024 * 1024),
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
        executable: z.boolean().default(false),
      },
      ({ path, content, encoding, executable }) =>
        this.writeFile(path, content, encoding, executable),
    );
    tool(
      "inspect_js",
      "Static analysis of the shipped browser JavaScript (default: the packaged game). op: scripts | symbols [maxDepth] | search REGEX [context] [max] | lines START END | refs IDENTIFIER.",
      {
        op: z.enum(["scripts", "symbols", "search", "lines", "refs"]),
        args: z.array(z.string()).max(4).default([]),
        file: z.string().optional(),
      },
      ({ op, args, file }) => this.inspect(op, args, file),
    );
    tool(
      "build",
      "Validate and freeze /output by content hash. Returns the artifact sha256 or the validation error.",
      {},
      () => this.build(),
    );
    tool(
      "smoke",
      "Deploy a frozen artifact into a fresh offline play sandbox with a fresh game: initialize, tools/list, strict stdout and interface policy. Returns full logs.",
      { sha256: z.string().regex(/^[0-9a-f]{64}$/) },
      ({ sha256 }) => this.smoke(sha256),
    );
    tool(
      "handoff",
      "Hand off a frozen artifact that passed smoke. This ends your session.",
      {
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        notes: z.string().max(4000).optional(),
      },
      ({ sha256, notes }) => this.handoffArtifact(sha256, notes),
    );
    return server;
  }
}

export interface BuilderOptions {
  output: string;
  llm: LlmEndpoint;
  maxSteps?: number;
  timeoutSeconds?: number;
  label?: string;
}
export interface BuilderResult {
  run: string;
  label: string | null;
  software: unknown;
  agent: AgentResult;
  handoff: Handoff | null;
  frozen: string[];
  smokes: Record<string, SmokeResult["status"]>;
  wall_seconds: number;
}
export async function builderPrompt() {
  const read = (name: string) =>
    readFile(resolve(root, "sandbox/public", name), "utf8");
  return {
    system:
      "You are the Builder. You explore unfamiliar software as a black box and build an MCP server for it. You have only the controller tools listed. There is no network.",
    user: `${await read("CONTRACT.md")}\n\n---\n\n${await read("PORT.md")}`,
  };
}
export async function runBuilder(
  options: BuilderOptions,
): Promise<BuilderResult> {
  const output = resolve(options.output);
  await mkdir(output, { recursive: false });
  const runId = newRunId("b");
  const began = performance.now();
  await writeFile(
    resolve(output, "provenance.json"),
    JSON.stringify(
      await provenance({
        role: "builder",
        run: runId,
        label: options.label ?? null,
        llm: { base_url: options.llm.base_url, model: options.llm.model },
      }),
      null,
      2,
    ) + "\n",
  );
  const sandbox = await BuilderSandbox.start(runId);
  const controller = new BuilderController(sandbox, output);
  const server = controller.server();
  const client = new Client({ name: "builder-agent", version: "1" });
  try {
    const software = JSON.parse(
      (await sandbox.exec(["cat", "/opt/target/manifest.json"])).stdout,
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    const tools = (await client.listTools()).tools;
    const prompt = await builderPrompt();
    const maxSteps = options.maxSteps ?? 400,
      timeoutSeconds = options.timeoutSeconds ?? 3 * 3600;
    const agent = await runAgent({
      llm: options.llm,
      system: prompt.system,
      user: `${prompt.user}\n\n---\n\nSession budget: at most ${maxSteps} model turns and ${Math.round((timeoutSeconds / 3600) * 10) / 10} hours of wall time. Nothing is handed off automatically; call handoff before the budget ends.`,
      maxToolResultChars: 24_000,
      compaction: {
        triggerChars: 1_200_000,
        targetChars: 600_000,
        keepRecent: 30,
      },
      session: {
        tools,
        call: async (name, args) =>
          (await client.callTool({ name, arguments: args }, undefined, {
            timeout: 660_000,
          })) as CallToolResult,
      },
      traceDir: output,
      maxSteps,
      deadlineMs: timeoutSeconds * 1000,
      shouldStop: () => controller.handoff !== null,
    });
    const result: BuilderResult = {
      run: runId,
      label: options.label ?? null,
      software,
      agent,
      handoff: controller.handoff,
      frozen: [...controller.frozen.keys()],
      smokes: Object.fromEntries(
        [...controller.smoked].map(([k, v]) => [k, v.status]),
      ),
      wall_seconds: Math.round(performance.now() - began) / 1000,
    };
    await writeFile(
      resolve(output, "builder-result.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
    return result;
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await sandbox.stop();
  }
}
