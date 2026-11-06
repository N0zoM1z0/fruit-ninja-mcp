import { spawn, execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { root, upstream } from "./upstream.js";
import { GameRuntime } from "./runtime.js";
import { hostGame } from "./host.js";
import type { Interface, Scene } from "./types.js";

export interface TrialOptions {
  output: string;
  interface: Interface;
  model: string;
  seed: number;
  duration: number;
  timeout: number;
  record_video?: boolean;
}
async function fingerprints(directory: string, extension: string) {
  return Promise.all(
    (await readdir(resolve(root, directory)))
      .filter((f) => f.endsWith(extension))
      .sort()
      .map(async (file) => ({
        path: `${directory}/${file}`,
        sha256: createHash("sha256")
          .update(await readFile(resolve(root, directory, file)))
          .digest("hex"),
      })),
  );
}
export async function runTrial(options: TrialOptions) {
  const { model, seed, duration, timeout } = options,
    mode = options.interface;
  if (
    !["mcp", "gui"].includes(mode) ||
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 4294967295 ||
    !Number.isInteger(duration) ||
    duration < 5 ||
    duration > 90 ||
    timeout < duration + 20
  )
    throw new Error(
      "Invalid interface, seed, duration (5..90) or timeout (at least duration+20)",
    );
  const output = resolve(options.output),
    work = resolve(output, "actor"),
    game = resolve(output, "game");
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  await mkdir(work);
  const runtime = await GameRuntime.launch({
    artifacts: game,
    recordVideo: options.record_video,
  });
  const host = await hostGame(runtime, mode);
  await runtime.prepare({ mode: "arcade", seed, duration_seconds: duration });
  const server = mode === "mcp" ? "fruit_ninja" : "desktop";
  const common = `Play ONE ${duration}-second REALTIME arcade round of Fruit Ninja. Maximize score by slicing fruit, aim for combos, and avoid bombs. The round is prepared but not started. Read the controls and get an initial observation, then start when ready. From the start onward, the game runs continuously during your thinking, every tool call, screenshots and input. Fruit will be missed while you are thinking. Do not pause, reset, restart, or stop just because strokes miss. Continue until the round ends, then report what you observed. The independent evaluator obtains the final score from the game.\n\nUse only your explicitly assigned ${server} tools. No shell, files, code execution, developer console, DOM, OCR, accessibility, network tools, other servers, or delegated agents. You decide every path and timing; the executor has no aiming policy. Both arms have identical bounded mouse paths: 2..32 points, 16..1000ms, maximum 5000px/s. Prepare before starting; after starting, unnecessary observation calls also cost real game time. Your total wall-time budget is ${timeout} seconds.`;
  const specific =
    mode === "mcp"
      ? "Your interface provides current visible-object state. Read get_game_rules and get_scene, then start_game once. Paths use CANVAS pixels. Reuse the scene returned by each action. Velocity can help predict where moving fruit will be when your path arrives; your observation may already be stale by then. No future state is available."
      : "Your interface is screenshot-only GUI. Read get_controls and get_screenshot, find the start button in the pixels, and click it. Then use drag with FULL-IMAGE pixel coordinates to move the mouse with its left button held. Action results are real screenshots only. There is no object state, text extraction, targeting or native game command. Judge fruit, bombs and score from pixels.";
  const prompt = common + "\n\n" + specific;
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
    model,
    "-c",
    'model_reasoning_effort="high"',
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    'web_search="disabled"',
    "-c",
    `mcp_servers.${server}.url=${JSON.stringify(host.url)}`,
    "-c",
    `mcp_servers.${server}.required=true`,
    "-c",
    `mcp_servers.${server}.startup_timeout_sec=30`,
    "-c",
    `mcp_servers.${server}.tool_timeout_sec=30`,
    "-c",
    `mcp_servers.${server}.default_tools_approval_mode="auto"`,
    "--json",
    "--output-last-message",
    resolve(output, "last-message.txt"),
    "-",
  ];
  const metadata = {
    schema_version: 2,
    interface: mode,
    model,
    reasoning_effort: "high",
    clock: "realtime",
    record_video: options.record_video ?? false,
    seed,
    duration_seconds: duration,
    codex_version: execFileSync("codex", ["--version"], {
      encoding: "utf8",
    }).trim(),
    upstream,
    runtime_files: await fingerprints("dist", ".js"),
    source_files: await fingerprints("src", ".ts"),
    args,
    started_at: new Date().toISOString(),
    protocol: "REALTIME-PROTOCOL.md",
    note: "The evaluator owns the game independently of the actor connection.",
  };
  await writeFile(
    resolve(output, "metadata.json"),
    JSON.stringify(metadata, null, 2) + "\n",
  );
  await writeFile(resolve(output, "prompt.txt"), prompt);
  console.log(
    `Starting ${mode}: ${model}/high, REALTIME ${duration}s, seed ${seed}; ${output}`,
  );
  const stdout = createWriteStream(resolve(output, "events.jsonl")),
    stderr = createWriteStream(resolve(output, "stderr.log"));
  const actor = spawn("codex", args, {
    cwd: work,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  actor.stdout!.pipe(stdout);
  actor.stderr!.pipe(stderr);
  actor.stdin!.end(prompt);
  let actorClosed = false,
    exitCode: number | null = null,
    exitSignal: NodeJS.Signals | null = null,
    spawnError: string | undefined;
  const closed = new Promise<void>((done) => {
    actor.once("close", (code, signal) => {
      actorClosed = true;
      exitCode = code;
      exitSignal = signal;
      done();
    });
    actor.once("error", (error) => {
      spawnError = error.message;
    });
  });
  const stop = (signal: NodeJS.Signals) => {
    try {
      process.kill(-actor.pid!, signal);
    } catch {}
  };
  const began = performance.now();
  let final: Scene | undefined, finishObserved: number | undefined;
  let timedOut = false,
    stoppedAfterFinish = false,
    actorExitedDuringPlay = false;
  try {
    while (true) {
      await sleep(100);
      final = await runtime.scene();
      const now = performance.now();
      if (final.phase === "finished") {
        finishObserved ??= now;
        if (actorClosed) break;
        if (now - finishObserved > 15_000) {
          stoppedAfterFinish = true;
          break;
        }
      } else if (actorClosed) {
        if (final.phase === "ready") break;
        actorExitedDuringPlay = true; // Keep the independent game alive to its natural end.
      }
      if (now - began > timeout * 1000 && final.phase !== "playing") {
        timedOut = true;
        break;
      }
      if (now - began > 60_000 && final.phase === "ready") {
        timedOut = true;
        break;
      }
    }
    if (!actorClosed) {
      stop("SIGTERM");
      await Promise.race([closed, sleep(5000)]);
      if (!actorClosed) {
        stop("SIGKILL");
        await closed;
      }
    }
    await Promise.all([finished(stdout), finished(stderr)]);
    final = await runtime.scene();
  } finally {
    if (!actorClosed) {
      stop("SIGKILL");
      await closed;
    }
    await host.close();
    await runtime.close();
  }
  const wallSeconds = (performance.now() - began) / 1000;
  const rows = (await readFile(resolve(output, "events.jsonl"), "utf8"))
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  let calls = 0,
    errors = 0,
    invalid = 0,
    observations = 0,
    actions = 0,
    usage: unknown;
  const allowed = new Set(
    mode === "mcp"
      ? [
          "get_game_rules",
          "get_scene",
          "start_game",
          "swipe",
          "wait",
          "get_events",
          "get_screenshot",
        ]
      : ["get_controls", "get_screenshot", "click", "drag", "wait"],
  );
  for (const row of rows) {
    const item = row.item;
    if (row.type === "item.completed" && item?.type === "mcp_tool_call") {
      calls++;
      if (item.error || item.result?.isError) errors++;
      if (item.server !== server || !allowed.has(item.tool)) invalid++;
      if (["get_scene", "get_screenshot"].includes(item.tool)) observations++;
      if (["swipe", "drag", "click"].includes(item.tool)) actions++;
    }
    if (
      row.type === "item.completed" &&
      [
        "command_execution",
        "file_change",
        "web_search",
        "collab_tool_call",
      ].includes(item?.type)
    )
      invalid++;
    if (row.type === "turn.completed") usage = row.usage;
  }
  const timeline = (await readFile(resolve(game, "timeline.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const playing = timeline.filter((row) => row.scene.phase === "playing");
  let drift = 0;
  if (playing.length > 1) {
    const first = playing[0];
    for (const row of playing)
      drift = Math.max(
        drift,
        Math.abs(
          row.scene.elapsed_ms -
            first.scene.elapsed_ms -
            (row.host_ms - first.host_ms),
        ),
      );
  }
  const finishWall = final?.clock_audit.finished_wall_elapsed_ms;
  const clockValid =
    final?.phase === "finished" &&
    finishWall !== null &&
    finishWall !== undefined &&
    Math.abs(finishWall - duration * 1000) < 500 &&
    drift < 150;
  const result = {
    schema_version: 2,
    interface: mode,
    model,
    reasoning_effort: "high",
    clock: "realtime",
    record_video: options.record_video ?? false,
    seed,
    duration_seconds: duration,
    exit_code: exitCode,
    exit_signal: exitSignal,
    spawn_error: spawnError,
    timed_out: timedOut,
    supervisor_stopped_after_finish: stoppedAfterFinish,
    actor_exited_during_play: actorExitedDuringPlay,
    wall_seconds: Math.round(wallSeconds * 1000) / 1000,
    completed_round: final?.phase === "finished",
    valid_interface: invalid === 0,
    clock_valid: clockValid,
    maximum_telemetry_clock_drift_ms: Math.round(drift * 1000) / 1000,
    tool_calls: calls,
    tool_errors: errors,
    invalid_tool_calls: invalid,
    explicit_observations: observations,
    input_actions: actions,
    usage,
    final_scene: final,
    note: "Actual realtime attempt. Zero scores, misses and tool errors are retained. No autopilot or artificial slowdown.",
  };
  await writeFile(
    resolve(output, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
  return result;
}
