import { spawn, execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { parseArgs } from "node:util";
import { root, upstream } from "../src/upstream.js";
import type { Scene } from "../src/types.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    model: { type: "string", default: "gpt-6.1-terra" },
    seed: { type: "string", default: "42" },
    duration: { type: "string", default: "20" },
    timeout: { type: "string", default: "900" },
  },
});
const seed = Number(values.seed),
  duration = Number(values.duration),
  deadline = Number(values.timeout);
if (
  !Number.isInteger(seed) ||
  seed < 0 ||
  seed > 4294967295 ||
  !Number.isInteger(duration) ||
  duration < 5 ||
  duration > 90 ||
  !Number.isFinite(deadline) ||
  deadline < 1
)
  throw new Error("Invalid seed, duration (5..90), or timeout");
const output = resolve(
  values.output ??
    `artifacts/trials/${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
const work = resolve(output, "actor"),
  game = resolve(output, "game");
await mkdir(work);
await mkdir(game);
const prompt = `Play one complete ${duration}-second arcade round of Fruit Ninja using only the fruit_ninja MCP tools. The game is already started. Maximize score by slicing fruit, aim for multi-fruit combos, and avoid bombs. Continue until the scene phase is finished, then report the final score, sliced fruit, escaped fruit, bombs hit, and max combo. Do not stop after a few successful strokes.\n\nRead get_game_rules and get_scene first. This is a decision-step game: thinking and observation do not consume game time; swipe and wait do. A timed swipe makes the fruit move while the blade moves. All action results contain the next scene, so use those directly. When the scene is empty, wait until objects appear; when fruit just enters from the bottom, allow it to rise to a useful slicing height. You decide coordinates, timings and paths.\n\nUse no shell, filesystem, code execution, developer console, network tools, other servers, or delegated agents. There is no need to create files. Only play the assigned game. You have ${deadline} seconds of wall time. Finish with a concise factual result. This is an exploratory MCP usability trial, not a measured comparison with vision.`;
await writeFile(resolve(output, "prompt.txt"), prompt);
const args = [
  "exec",
  "--ignore-user-config",
  "--ephemeral",
  "--skip-git-repo-check",
  "-C",
  work,
  "--sandbox",
  "read-only",
  "-c",
  'approval_policy="never"',
  "--disable",
  "shell_tool",
  "--disable",
  "multi_agent",
  "-m",
  values.model!,
  "-c",
  'model_reasoning_effort="high"',
  "-c",
  "project_doc_max_bytes=0",
  "-c",
  'web_search="disabled"',
  "-c",
  `mcp_servers.fruit_ninja.command=${JSON.stringify(process.execPath)}`,
  "-c",
  `mcp_servers.fruit_ninja.args=${JSON.stringify([resolve(root, "dist/cli.js"), "serve", "--locked", "--seed", String(seed), "--duration", String(duration), "--artifacts", game])}`,
  "-c",
  "mcp_servers.fruit_ninja.required=true",
  "-c",
  "mcp_servers.fruit_ninja.startup_timeout_sec=30",
  "-c",
  "mcp_servers.fruit_ninja.tool_timeout_sec=30",
  "-c",
  'mcp_servers.fruit_ninja.default_tools_approval_mode="auto"',
  "--json",
  "--output-last-message",
  resolve(output, "last-message.txt"),
  "-",
];
const runtimeFiles = await Promise.all(
    (await readdir(resolve(root, "dist")))
      .filter((name) => name.endsWith(".js"))
      .sort()
      .map(async (name) => ({
        path: `dist/${name}`,
        sha256: createHash("sha256")
          .update(await readFile(resolve(root, "dist", name)))
          .digest("hex"),
      })),
  ),
  metadata = {
    model: values.model,
    reasoning_effort: "high",
    codex_version: execFileSync("codex", ["--version"], {
      encoding: "utf8",
    }).trim(),
    seed,
    duration_seconds: duration,
    clock: "decision",
    upstream,
    runtime_files: runtimeFiles,
    args,
    started_at: new Date().toISOString(),
  };
await writeFile(
  resolve(output, "metadata.json"),
  JSON.stringify(metadata, null, 2) + "\n",
);
console.log(
  `Starting ${values.model} / high; ${duration}s arcade, seed ${seed}`,
);
console.log(`Artifacts: ${output}`);
const stdout = createWriteStream(resolve(output, "events.jsonl"));
const stderr = createWriteStream(resolve(output, "stderr.log"));
const child = spawn("codex", args, {
  cwd: work,
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdout!.pipe(stdout);
child.stderr!.pipe(stderr);
child.stdin!.end(prompt);
let timedOut = false,
  forceKill: NodeJS.Timeout | undefined;
const stop = (signal: NodeJS.Signals) => {
  try {
    process.kill(-child.pid!, signal);
  } catch {}
};
const timer = setTimeout(() => {
  timedOut = true;
  stop("SIGTERM");
  forceKill = setTimeout(() => stop("SIGKILL"), 5000);
}, deadline * 1000);
const started = performance.now();
let code: number | null;
try {
  code = await new Promise<number | null>((done, reject) => {
    child.once("close", done);
    child.once("error", reject);
  });
} finally {
  clearTimeout(timer);
  if (forceKill) clearTimeout(forceKill);
}
await Promise.all([finished(stdout), finished(stderr)]);
const wallSeconds = (performance.now() - started) / 1000;
const rows = (await readFile(resolve(output, "events.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
let toolCalls = 0,
  toolErrors = 0,
  invalidTools = 0,
  usage: unknown;
for (const row of rows) {
  const item = row.item as Record<string, unknown> | undefined;
  if (row.type === "item.completed" && item?.type === "mcp_tool_call") {
    toolCalls++;
    if (
      item.error ||
      (item.result as { isError?: boolean } | undefined)?.isError
    )
      toolErrors++;
    if (item.server !== "fruit_ninja") invalidTools++;
  }
  if (
    row.type === "item.completed" &&
    item &&
    [
      "command_execution",
      "file_change",
      "web_search",
      "collab_tool_call",
    ].includes(String(item.type))
  )
    invalidTools++;
  if (row.type === "turn.completed") usage = row.usage;
}
const state = await readFile(resolve(game, "state.json"), "utf8").then(
  (bytes) => JSON.parse(bytes) as Scene,
  () => undefined,
);
const result = {
  model: values.model,
  reasoning_effort: "high",
  seed,
  duration_seconds: duration,
  clock: "decision",
  exit_code: code,
  timed_out: timedOut,
  wall_seconds: Math.round(wallSeconds * 1000) / 1000,
  completed_round: state?.phase === "finished",
  valid_interface: invalidTools === 0,
  tool_calls: toolCalls,
  tool_errors: toolErrors,
  invalid_tool_calls: invalidTools,
  usage,
  final_scene: state,
  note: "Exploratory MCP-only usability trial; no vision comparison or general performance claim.",
};
await writeFile(
  resolve(output, "result.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
if (
  code !== 0 ||
  timedOut ||
  !result.completed_round ||
  !result.valid_interface
)
  process.exitCode = 1;
