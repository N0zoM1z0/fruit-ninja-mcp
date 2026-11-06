import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runTrial } from "../src/trial.js";
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    model: { type: "string", default: "gpt-6.1-terra" },
    seed: { type: "string", default: "42" },
    duration: { type: "string", default: "60" },
    timeout: { type: "string", default: "180" },
    "record-video": { type: "boolean", default: false },
    policy: { type: "string", default: "baseline" },
  },
});
const output = resolve(
  values.output ??
    `artifacts/comparisons/${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const common = {
  model: values.model!,
  seed: Number(values.seed),
  duration: Number(values.duration),
  timeout: Number(values.timeout),
  record_video: values["record-video"],
  policy: values.policy as "baseline" | "coverage",
};
await writeFile(
  resolve(output, "protocol.json"),
  JSON.stringify(
    {
      ...common,
      clock: "realtime",
      order: ["mcp", "gui"],
      changed_game_parameters_between_arms: false,
    },
    null,
    2,
  ) + "\n",
);
const mcp = await runTrial({
  ...common,
  interface: "mcp",
  output: resolve(output, "mcp"),
});
const gui = await runTrial({
  ...common,
  interface: "gui",
  output: resolve(output, "gui"),
});
const result = {
  clock: "realtime",
  model: common.model,
  reasoning_effort: "high",
  seed: common.seed,
  duration_seconds: common.duration,
  valid:
    mcp.completed_round &&
    gui.completed_round &&
    mcp.valid_interface &&
    gui.valid_interface &&
    mcp.clock_valid &&
    gui.clock_valid,
  score_difference:
    (mcp.final_scene?.stats.score ?? 0) - (gui.final_scene?.stats.score ?? 0),
  mcp,
  gui,
  note: "One sequential paired attempt. Preserve both results regardless of which arm wins; no broad reliability claim.",
};
await writeFile(
  resolve(output, "comparison.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(`Comparison saved: ${output}/comparison.json`);
if (!result.valid) process.exitCode = 1;
