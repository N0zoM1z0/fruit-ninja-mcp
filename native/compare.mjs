#!/usr/bin/env node
/** One unseeded native round per interface, with a real Codex player. */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";
import { openSession } from "./session.mjs";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    model: { type: "string", default: "gpt-6.1-terra" },
    reasoning: { type: "string", default: "high" },
    mode: { type: "string", default: "both" },
  },
});
const output = path.resolve(
  values.output ??
    `.local/windows/comparisons/${new Date().toISOString().replaceAll(":", "-")}`,
);
if (!["mcp", "gui", "both"].includes(values.mode))
  throw new Error("mode must be mcp, gui or both");
await mkdir(output, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function prompt(mode) {
  return `Play ONE Arcade round of the original Windows Fruit Ninja HD. Maximize final score, avoid bombs, and make combos. You are the evaluated player. Use ONLY tools from the fruit_ninja MCP server. Do not use shell, files, network, browser, other servers, agents, OCR or accessibility. Your first tool call triggers the evaluator's common menu initialization and starts the 60-game-second clock, then executes the requested tool. Call a tool immediately. Never restart, replay, pause, quit, or navigate menus. After initialization, time runs during thinking and tool calls. Keep playing until the result screen, then finish with a short score report. Do not stop early to narrate.
${mode === "mcp" ? "Use game_state for native state, and slice repeatedly to invoke the REA-derived ballistic interception planner and execute one bounded stroke per call. The planner predicts moving fruit and avoids native bomb colliders. No need to take screenshots each action. Calls do not loop automatically: keep invoking slice until the round ends." : "You have ONLY raw game screenshots and native mouse input. Start with get_screenshot. drag executes one timed mouse-down path in screenshot pixel coordinates and returns a fresh screenshot. Choose paths yourself from these images. The viewport is 1024 by 768; use coordinates inside it. Paths need 2..256 points, first t_ms=0, strictly increasing t_ms up to 1000, speed <=5000 px/s. Latency matters: use efficient thinking and broad useful coverage strokes of about 600–900ms, with few vertices, while avoiding visible bombs. Fruit moves between screenshots and actions. Every drag returns your next observation; keep playing without extra narration."}`;
}

async function run(mode) {
  const dir = path.join(output, mode);
  await mkdir(dir, { recursive: true });
  const actorDir = path.join(dir, "actor");
  await mkdir(actorDir, { recursive: true });
  const session = await openSession({
    output: dir,
    mode,
    model: `${values.model} / ${values.reasoning}`,
    startOnFirstTool: true,
  });
  let actor,
    exit,
    exitInfo,
    stoppedByEvaluator = false;
  async function stop() {
    if (!actor || exitInfo) return;
    stoppedByEvaluator = true;
    try {
      process.kill(-actor.pid, "SIGTERM");
    } catch {}
    await Promise.race([exit, sleep(2500)]);
    if (!exitInfo) {
      try {
        process.kill(-actor.pid, "SIGKILL");
      } catch {}
      await exit;
    }
  }
  try {
    const text = prompt(mode).replace(
      "1024 by 768",
      `${session.metadata.actor_screenshot.width} by ${session.metadata.actor_screenshot.height}`,
    );
    await writeFile(path.join(dir, "prompt.txt"), text);
    const args = [
      "exec",
      "--ignore-user-config",
      "--ephemeral",
      "--skip-git-repo-check",
      "-C",
      actorDir,
      "--sandbox",
      "read-only",
      "-c",
      'approval_policy="never"',
      "--disable",
      "shell_tool",
      "--disable",
      "multi_agent",
      "-m",
      values.model,
      "-c",
      `model_reasoning_effort="${values.reasoning}"`,
      "-c",
      "project_doc_max_bytes=0",
      "-c",
      'web_search="disabled"',
      "-c",
      `mcp_servers.fruit_ninja.url="${session.url}"`,
      "-c",
      "mcp_servers.fruit_ninja.required=true",
      "-c",
      "mcp_servers.fruit_ninja.startup_timeout_sec=30",
      "-c",
      "mcp_servers.fruit_ninja.tool_timeout_sec=60",
      "-c",
      'mcp_servers.fruit_ninja.default_tools_approval_mode="approve"',
      "--json",
      "--output-last-message",
      path.join(dir, "last-message.txt"),
      "-",
    ];
    await writeFile(
      path.join(dir, "actor-config.json"),
      JSON.stringify(
        {
          model: values.model,
          reasoning: values.reasoning,
          args,
          interface: mode,
        },
        null,
        2,
      ),
    );
    const events = createWriteStream(path.join(dir, "events.jsonl")),
      errors = createWriteStream(path.join(dir, "stderr.log"));
    console.log(
      `${mode}: awaiting first player tool; ${values.model} / ${values.reasoning}`,
    );
    actor = spawn("codex", args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    actor.stdout.pipe(events);
    actor.stderr.pipe(errors);
    exit = new Promise((resolve) => {
      actor.once("error", (error) => {
        exitInfo = { error: error.message, at: new Date().toISOString() };
        resolve(exitInfo);
      });
      actor.once("close", (code, signal) => {
        exitInfo = { code, signal, at: new Date().toISOString() };
        resolve(exitInfo);
      });
    });
    actor.stdin.end(text);
    // The evaluator's native referee keeps running even if the player exits.
    const monitor = setInterval(() => {
      if (session.finished) void stop();
    }, 100);
    let result;
    try {
      result = await session.waitResult();
    } finally {
      clearInterval(monitor);
      await stop();
    }
    await Promise.all([
      new Promise((r) => (events.closed ? r() : events.once("close", r))),
      new Promise((r) => (errors.closed ? r() : errors.once("close", r))),
    ]);
    const rows = (await readFile(path.join(dir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((x) => JSON.parse(x));
    const items = rows
      .filter((x) => x.type === "item.completed")
      .map((x) => x.item);
    const calls = items.filter((x) => x.type === "mcp_tool_call");
    const successful = calls.filter(
      (x) => x.status === "completed" && !x.error && !x.result?.isError,
    );
    const infrastructureErrors = calls.filter((x) =>
      x.error?.message?.includes("requires approval"),
    );
    const allowed =
      mode === "mcp"
        ? ["get_controls", "get_screenshot", "game_state", "slice"]
        : ["get_controls", "get_screenshot", "drag", "click"];
    const violations = items.filter(
      (x) =>
        ["command_execution", "file_change", "web_search"].includes(x.type) ||
        (x.type === "mcp_tool_call" &&
          (x.server !== "fruit_ninja" || !allowed.includes(x.tool))),
    );
    Object.assign(result, {
      actor_exit: exitInfo,
      stopped_by_evaluator: stoppedByEvaluator,
      completed_actor_calls: calls.length,
      successful_actor_calls: successful.length,
      infrastructure_ok:
        successful.length > 0 && infrastructureErrors.length === 0,
      interface_audit: {
        passed: violations.length === 0 && calls.length > 0,
        violations,
      },
      unseeded: true,
    });
    await writeFile(
      path.join(dir, "result.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
    console.log(
      `${mode}: score ${result.score}; ${calls.length} player tool calls; audit ${result.interface_audit.passed}`,
    );
    return result;
  } catch (error) {
    await writeFile(
      path.join(dir, "failure.json"),
      JSON.stringify({ error: error.stack }, null, 2),
    );
    throw error;
  } finally {
    await stop();
    await session.close();
  }
}

const results = [];
for (const mode of values.mode === "both" ? ["mcp", "gui"] : [values.mode])
  results.push(await run(mode));
const summary = {
  model: values.model,
  reasoning: values.reasoning,
  results,
  protocol: [
    "One fresh, unseeded Arcade round per interface; no cherry-picking or retries.",
    "Both interfaces start Arcade on the first player tool call; model cold startup occurs before the game clock starts.",
    "Identical common menu initialization, native realtime clock, 1024x768 actor images, 5000 px/s input cap and 1 second maximum stroke.",
    "MCP includes native observation AND ballistic planning automation; GUI model chooses paths from pixels.",
    "Game-only recordings; native referee and diagnostic telemetry remain private to the evaluator.",
    "Single-pair demonstration, not a same-seed statistical benchmark.",
  ],
};
await writeFile(
  path.join(output, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(output);
