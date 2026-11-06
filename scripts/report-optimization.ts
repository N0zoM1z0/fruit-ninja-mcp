import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { root } from "../src/upstream.js";

const { values } = parseArgs({
  options: {
    trials: { type: "string" },
    output: {
      type: "string",
      default: "results/optimization-validation-v1.json",
    },
  },
});
if (!values.trials) throw new Error("Provide --trials VALIDATION_DIRECTORY");
const directory = resolve(values.trials),
  read = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const manifest = await read(resolve(directory, "manifest.json"));
const rows = [];
for (const item of manifest.cases) {
  const dir = resolve(directory, item.name),
    meta = await read(resolve(dir, "metadata.json")),
    result = await read(resolve(dir, "result.json"));
  for (const file of meta.source_files) {
    const bytes = execFileSync(
      "git",
      ["show", `${manifest.source_commit}:${file.path}`],
      { cwd: root },
    );
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
      throw new Error(`Source mismatch: ${item.name}/${file.path}`);
  }
  for (const key of ["seed", "interface", "policy", "mcp_profile", "feedback"])
    if (meta[key] !== item[key])
      throw new Error(`Configuration mismatch: ${item.name}/${key}`);
  if (
    meta.model !== manifest.model ||
    meta.reasoning_effort !== "high" ||
    meta.duration_seconds !== 60 ||
    meta.record_video !== false
  )
    throw new Error(`Shared conditions differ: ${item.name}`);
  const first = JSON.parse(
    (await readFile(resolve(dir, "game/trace.jsonl"), "utf8")).split("\n")[0],
  );
  rows.push({
    trial_id: item.name,
    ...item,
    stats: result.final_scene.stats,
    completed_round: result.completed_round,
    valid_interface: result.valid_interface,
    clock_valid: result.clock_valid,
    round_wall_ms: result.final_scene.clock_audit.finished_wall_elapsed_ms,
    maximum_clock_drift_ms: result.maximum_telemetry_clock_drift_ms,
    tool_calls: result.tool_calls,
    tool_errors: result.tool_errors,
    instrumented_game_sha256: first.instrumented_game_sha256,
  });
}
if (new Set(rows.map((row) => row.instrumented_game_sha256)).size !== 1)
  throw new Error("Game instrumentation differs between validation arms");
const groups = {
  baseline_mcp: rows.filter(
    (row) => row.interface === "mcp" && row.policy === "baseline",
  ),
  selected_mcp: rows.filter(
    (row) => row.interface === "mcp" && row.policy === "coverage",
  ),
  selected_gui: rows.filter((row) => row.interface === "gui"),
};
const means = Object.fromEntries(
  Object.entries(groups).map(([name, rows]) => [
    name,
    {
      attempts: rows.length,
      score: rows.reduce((sum, row) => sum + row.stats.score, 0) / rows.length,
      sliced:
        rows.reduce((sum, row) => sum + row.stats.sliced, 0) / rows.length,
    },
  ]),
);
const report = {
  schema_version: 1,
  source_commit: manifest.source_commit,
  model: manifest.model,
  reasoning_effort: "high",
  duration_seconds: 60,
  clock: "realtime",
  record_video: false,
  held_out_seeds: [2026, 7],
  source_fingerprints_verified: true,
  identical_instrumented_game: true,
  all_rounds_valid: rows.every(
    (row) => row.completed_round && row.valid_interface && row.clock_valid,
  ),
  trials_directory: values.trials,
  rows,
  means,
  note: "One attempt per condition and held-out seed, selected using development seed 42 only. This is a small practical validation, not a stable win-rate or global-optimum claim. GUI and selected MCP share coverage guidance and asynchronous native-input capabilities. All outcomes are retained.",
};
await writeFile(
  resolve(values.output!),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({ means, all_rounds_valid: report.all_rounds_valid }, null, 2),
);
if (!report.all_rounds_valid) process.exitCode = 1;
