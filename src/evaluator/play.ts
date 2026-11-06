// PRIVATE: GUI-play and generated-MCP-play on the same refereed game, clock and executor.
// GUI: screenshot/click/drag tools (in-process MCP). MCP: a frozen agent-built MCP runs in an
// offline sandbox and reaches the game only through the game port (adapter + native input).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GameRuntime, viewport, type Integrity } from "../runtime.js";
import { buildServer } from "../server.js";
import { pathLimits, type TimedPoint } from "../public/executor.js";
import {
  PortError,
  startPort,
  type PortBackend,
  type PortGate,
  type PortRow,
} from "../public/port.js";
import type { Scene } from "../types.js";
import { verifyFrozen, type FrozenRecord } from "./freeze.js";
import {
  interfacePolicy,
  resultViolations,
  type PolicyResult,
} from "./policy.js";
import {
  runAgent,
  type AgentResult,
  type LlmEndpoint,
  type ToolSession,
} from "./llm.js";
import { provenance } from "./provenance.js";
import {
  newRunId,
  playArgs,
  removeRunContainers,
  socketDir as makeSocketDir,
} from "./sandbox.js";
import { StrictStdioTransport } from "./stdio.js";
import { withTimeout } from "./acceptance.js";

export type PlayInterface = "gui" | "mcp";
export interface PlayOptions {
  output: string;
  interface: PlayInterface;
  /** Frozen artifact directory (contains build.json and mcp/); MCP mode only. */
  frozen?: string;
  seed: number;
  duration: number;
  profile?: "standard" | "async";
  llm: LlmEndpoint;
  maxSteps?: number;
  timeoutSeconds?: number;
  recordVideo?: boolean;
  /** Developer negative controls only: play even if the static interface policy fails. */
  allowPolicyFailure?: boolean;
  label?: string;
}

/** One native input (path or click) per actor tool call, and none outside a call. */
export class CallGate implements PortGate {
  private inflight: number | null = null;
  private used = false;
  begin(id: number) {
    this.inflight = id;
    this.used = false;
  }
  end(id: number) {
    if (this.inflight === id) this.inflight = null;
  }
  authorize() {
    if (this.inflight === null)
      throw new PortError(
        "NO_ACTIVE_TOOL_CALL",
        "native input is accepted only during an actor tool call",
        403,
      );
    if (this.used)
      throw new PortError(
        "INPUT_BUDGET_EXCEEDED",
        "one native input (path or click) per actor tool call",
        429,
      );
    this.used = true;
  }
}

/** Evaluator port backend: the SAME runtime executor as GUI drag/click; generic status only. */
export class RuntimeBackend implements PortBackend {
  constructor(
    readonly runtime: GameRuntime,
    readonly profile: "standard" | "async",
  ) {}
  info() {
    return {
      viewport,
      coordinates:
        "Page CSS pixels of the 1440x960 viewport, origin top-left (same as GUI screenshots).",
      limits: pathLimits,
      profile: this.profile,
      adapter: {
        loaded: this.runtime.adapterExports.length > 0,
        exports: this.runtime.adapterExports,
      },
      input_policy:
        "Native mouse only. One input (path or click) per actor tool call. One path executes at a time; busy requests are rejected, never queued.",
    };
  }
  async adapterCall(fn: string, args: unknown) {
    try {
      return await this.runtime.adapterCall(fn, args);
    } catch (error) {
      const message = String(
        error instanceof Error ? error.message : error,
      ).replace(/^jsHandle\.evaluate: /, "");
      const code = /^(ADAPTER_[A-Z_]+):/.exec(message)?.[1] ?? "ADAPTER_ERROR";
      throw new PortError(
        code,
        message.slice(0, 1000),
        code === "ADAPTER_MISSING" ? 404 : 400,
      );
    }
  }
  private generic() {
    const status = this.runtime.actionStatus();
    const previous = status.previous_action;
    return {
      pending_action: status.pending_action,
      previous_action: previous
        ? {
            action_id: previous.action_id,
            status: previous.status,
            actual_duration_ms: previous.actual_duration_ms,
            error: previous.error,
          }
        : null,
    };
  }
  status() {
    return this.generic();
  }
  async path(points: TimedPoint[], wait: boolean) {
    const map = (error: unknown): never => {
      const message = String(error instanceof Error ? error.message : error);
      if (/ROUND_NOT_PLAYING/.test(message))
        throw new PortError(
          "ROUND_NOT_PLAYING",
          "the round is not playing",
          409,
        );
      throw new PortError(
        "INVALID_PATH",
        message.replace(/^.*?Error: /, "").slice(0, 300),
      );
    };
    if (this.profile === "async" && !wait) {
      const submitted = await this.runtime
        .submitPath({ points }, "screen")
        .catch(map);
      if (!submitted.accepted)
        throw new PortError(
          "BUSY",
          "a path is executing; nothing was queued",
          409,
        );
      return {
        accepted: true,
        action_id: submitted.action_id,
        ...this.generic(),
      };
    }
    const result = await this.runtime.portPath(points).catch(map);
    return {
      accepted: true,
      actual_duration_ms: result.actual_duration_ms,
      ...this.generic(),
    };
  }
  async click(x: number, y: number) {
    await this.runtime.click(x, y).catch((error) => {
      throw new PortError(
        "INVALID_CLICK",
        String(error instanceof Error ? error.message : error).slice(0, 300),
      );
    });
    return { accepted: true };
  }
}

export function playPrompt(mode: PlayInterface, duration: number) {
  const common = `Play ONE ${duration}-second REALTIME arcade round of Fruit Ninja. Maximize score by slicing fruit, aim for combos, and avoid bombs. The round is prepared but not started; start it when you are ready. From the start onward the game runs continuously during your thinking and every tool call; it never pauses, resets or restarts. Keep playing until the round ends. The independent evaluator reads the final score from the game.\n\nUse only the tools provided to you. Each tool call may perform at most one native mouse input (one path or one click). Paths have 2..32 points with integer t_ms starting at 0, last 16..1000 ms and move at most 5000 px/s.`;
  const line =
    mode === "gui"
      ? "Your interface is screenshot-only GUI: read get_controls, take screenshots, find the start button in the image and click it, then drag through fruit using full-image pixel coordinates."
      : "Your interface is an MCP server that was built for this game by another agent. Read its tool descriptions, then use its tools to start and play the round.";
  return {
    system: "You are playing a realtime browser game through tools.",
    user: `${common}\n\n${line}`,
  };
}

function drift(timeline: { host_ms: number; scene: Scene }[]) {
  const playing = timeline.filter((row) => row.scene.phase === "playing");
  let value = 0;
  if (playing.length > 1) {
    const first = playing[0];
    for (const row of playing)
      value = Math.max(
        value,
        Math.abs(
          row.scene.elapsed_ms -
            first.scene.elapsed_ms -
            (row.host_ms - first.host_ms),
        ),
      );
  }
  return value;
}

export async function runPlay(options: PlayOptions) {
  const output = resolve(options.output);
  const profile = options.profile ?? "standard";
  if (
    !Number.isInteger(options.seed) ||
    options.seed < 0 ||
    options.seed > 4294967295 ||
    !Number.isInteger(options.duration) ||
    options.duration < 5 ||
    options.duration > 90
  )
    throw new Error("Invalid seed or duration (5..90)");
  if (options.interface === "mcp" && !options.frozen)
    throw new Error("MCP play requires a frozen artifact");
  await mkdir(output, { recursive: false });
  const runId = newRunId("p");
  const began = performance.now();
  await writeFile(
    resolve(output, "provenance.json"),
    JSON.stringify(
      await provenance({
        role: `play-${options.interface}`,
        run: runId,
        label: options.label ?? null,
        llm: { base_url: options.llm.base_url, model: options.llm.model },
      }),
      null,
      2,
    ) + "\n",
  );
  const runtime = await GameRuntime.launch({
    artifacts: resolve(output, "game"),
    recordVideo: options.recordVideo,
  });
  const portRows: PortRow[] = [];
  const blocked: { tool: string; violations: string[] }[] = [];
  let legalPaths = 0,
    legalClicks = 0;
  let frozen: FrozenRecord | null = null;
  let policy: PolicyResult | null = null;
  let agent: AgentResult | null = null;
  let setupError: string | null = null;
  let stdoutViolations: string[] = [];
  const closers: (() => Promise<unknown>)[] = [];
  try {
    await runtime.prepare({
      mode: "arcade",
      seed: options.seed,
      duration_seconds: options.duration,
    });
    let session: ToolSession;
    if (options.interface === "gui") {
      const server = buildServer(
        runtime,
        "gui",
        profile === "async" ? "async" : "standard",
      );
      const client = new Client({ name: "gui-actor", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(b);
      await client.connect(a);
      closers.push(
        () => client.close(),
        () => server.close(),
      );
      session = {
        tools: (await client.listTools()).tools,
        call: async (name, args) => {
          const result = (await client.callTool({
            name,
            arguments: args,
          })) as CallToolResult;
          if (!result.isError && ["drag", "submit_drag"].includes(name))
            legalPaths++;
          if (!result.isError && name === "click") legalClicks++;
          return result;
        },
      };
    } else {
      frozen = await verifyFrozen(options.frozen!);
      if (frozen.adapter)
        await runtime.injectAdapter(
          await readFile(resolve(options.frozen!, frozen.adapter.path), "utf8"),
        );
      const gate = new CallGate();
      const socketDir = await makeSocketDir(runId);
      const port = await startPort({
        socketPath: resolve(socketDir, "port.sock"),
        backend: new RuntimeBackend(runtime, profile),
        gate,
        log: (row) => portRows.push(row),
      });
      closers.push(() => port.close());
      const transport = new StrictStdioTransport(
        "docker",
        playArgs(runId, resolve(options.frozen!, "mcp"), socketDir),
        resolve(output, "mcp-stdio.jsonl"),
        resolve(output, "mcp-stderr.log"),
      );
      const client = new Client({ name: "mcp-actor", version: "1" });
      closers.push(async () => {
        stdoutViolations = transport.violations;
        await client.close().catch(() => {});
        await transport.close();
        await removeRunContainers(runId);
      });
      await withTimeout(client.connect(transport), 30_000, "MCP initialize");
      const tools = (
        await withTimeout(client.listTools(), 15_000, "tools/list")
      ).tools;
      policy = interfacePolicy(tools, frozen.manifest);
      if (!policy.ok && !options.allowPolicyFailure)
        throw new Error(`INTERFACE_REJECTED: ${policy.reasons.join(", ")}`);
      let callId = 0;
      session = {
        tools,
        call: async (name, args) => {
          const id = ++callId;
          gate.begin(id);
          try {
            const result = (await client.callTool(
              { name, arguments: args },
              undefined,
              { timeout: 30_000 },
            )) as CallToolResult;
            const violations = resultViolations(result);
            if (violations.length) {
              blocked.push({ tool: name, violations });
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `IMAGE_CONTENT_BLOCKED: generated MCP tools may not relay pixels (${violations.join(", ")})`,
                  },
                ],
              };
            }
            return result;
          } finally {
            gate.end(id);
          }
        },
      };
    }
    // Stop the actor a few seconds after the round has finished.
    let finishedAt: number | null = null;
    const watcher = setInterval(() => {
      void runtime.peek().then(
        (scene) => {
          if (scene.phase === "finished") finishedAt ??= performance.now();
        },
        () => {},
      );
    }, 250);
    try {
      const prompt = playPrompt(options.interface, options.duration);
      agent = await runAgent({
        llm: options.llm,
        system: prompt.system,
        user: prompt.user,
        session,
        traceDir: resolve(output, "actor"),
        maxSteps: options.maxSteps ?? 2000,
        deadlineMs: (options.timeoutSeconds ?? options.duration + 120) * 1000,
        vision: options.interface === "gui",
        shouldStop: () =>
          finishedAt !== null && performance.now() - finishedAt > 3000,
      });
    } finally {
      clearInterval(watcher);
    }
    // A started round always runs to its natural end, whatever the actor did.
    let scene = await runtime.scene();
    const waitStarted = performance.now();
    while (
      scene.phase === "playing" &&
      performance.now() - waitStarted < (options.duration + 15) * 1000
    ) {
      await sleep(200);
      scene = await runtime.scene();
    }
  } catch (error) {
    setupError = String(error instanceof Error ? error.message : error);
  }
  let final: Scene | null = null,
    integrity: Integrity | null = null,
    events: unknown[] = [];
  try {
    final = await runtime.scene();
    integrity = await runtime.integrity();
    events = (await runtime.events(0, 10_000)).events;
  } catch (error) {
    setupError ??= `referee unavailable: ${String(error)}`;
  }
  for (const close of closers.reverse()) await close().catch(() => {});
  await runtime.close();
  if (options.interface === "mcp") {
    for (const row of portRows)
      if (row.status === 200 && row.route === "/v1/input/path") legalPaths++;
      else if (row.status === 200 && row.route === "/v1/input/click")
        legalClicks++;
  }
  const rejected: Record<string, number> = {};
  for (const row of portRows)
    if (row.status !== 200) {
      const code = (row.response as any)?.error?.code ?? `HTTP_${row.status}`;
      rejected[code] = (rejected[code] ?? 0) + 1;
    }
  const timeline = (
    await readFile(resolve(output, "game/timeline.jsonl"), "utf8").catch(
      () => "",
    )
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const maxDrift = drift(timeline);
  const finishWall = final?.clock_audit.finished_wall_elapsed_ms;
  const completed = final?.phase === "finished";
  const clockValid =
    completed &&
    finishWall !== null &&
    finishWall !== undefined &&
    Math.abs(finishWall - options.duration * 1000) < 500 &&
    maxDrift < 150;
  const reasons: string[] = [];
  if (setupError) reasons.push(`SETUP_ERROR:${setupError.slice(0, 200)}`);
  if (!final || final.round === 0) reasons.push("ROUND_NOT_STARTED");
  else if (!completed) reasons.push("ROUND_INCOMPLETE");
  if (completed && !clockValid) reasons.push("CLOCK_INVALID");
  if (legalPaths === 0) reasons.push("NO_LEGAL_INPUT");
  if (!final || final.stats.sliced + final.stats.bombs_hit === 0)
    reasons.push("NO_GAMEPLAY_EFFECT");
  for (const v of integrity?.violations ?? [])
    reasons.push(`INTEGRITY_VIOLATION:${v.kind}`);
  if (integrity && !integrity.lockdown)
    reasons.push("INTEGRITY_VIOLATION:lockdown_missing");
  for (const reason of policy?.reasons ?? [])
    reasons.push(`INTERFACE_REJECTED:${reason}`);
  if (blocked.length) reasons.push("PIXELS_RELAYED");
  if (stdoutViolations.length) reasons.push("STDOUT_NOT_JSON_RPC");
  const result = {
    schema_version: 3,
    interface: options.interface,
    label: options.label ?? null,
    run: runId,
    clock: "realtime",
    record_video: options.recordVideo ?? false,
    profile,
    seed: options.seed,
    duration_seconds: options.duration,
    llm: { base_url: options.llm.base_url, model: options.llm.model },
    frozen: frozen
      ? {
          sha256: frozen.sha256,
          tools: frozen.manifest.tools.map((t) => t.name),
          adapter: frozen.adapter,
          fixture: frozen.manifest.fixture ?? null,
        }
      : null,
    interface_policy: policy,
    image_results_blocked: blocked,
    port: {
      requests: portRows.length,
      rejected,
      adapter_calls: portRows.filter((r) => r.route === "/v1/adapter").length,
    },
    legal_paths: legalPaths,
    legal_clicks: legalClicks,
    agent,
    round_started: !!final && final.round > 0,
    completed_round: completed,
    clock_valid: clockValid,
    maximum_telemetry_clock_drift_ms: Math.round(maxDrift * 1000) / 1000,
    integrity,
    score: final?.stats.score ?? null,
    stats: final?.stats ?? null,
    attributed_slices: (events as any[]).filter(
      (e) => e.type === "fruit_sliced" && e.attributed,
    ).length,
    valid_gameplay: reasons.length === 0,
    failure_reasons: reasons,
    wall_seconds: Math.round(performance.now() - began) / 1000,
    final_scene: final,
  };
  await writeFile(
    resolve(output, "events.json"),
    JSON.stringify(events, null, 1) + "\n",
  );
  await writeFile(
    resolve(output, "port.jsonl"),
    portRows.map((r) => JSON.stringify(r)).join("\n") +
      (portRows.length ? "\n" : ""),
  );
  await writeFile(
    resolve(output, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  return result;
}
