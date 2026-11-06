import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { runTrial } from "../src/trial.js";
import type { Feedback, Interface, McpProfile } from "../src/types.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "mcp-profile": { type: "string", default: "standard" },
    feedback: { type: "string", default: "full" },
  },
});
if (!values.output) throw new Error("Provide a new --output directory");
const output = resolve(values.output),
  profile = values["mcp-profile"] as McpProfile,
  feedback = values.feedback as Feedback;
const cases: {
  seed: number;
  interface: Interface;
  policy: "baseline" | "coverage";
  mcp_profile: McpProfile;
  feedback: Feedback;
  name: string;
}[] = [];
for (const seed of [2026, 7]) {
  const baseline = {
    seed,
    interface: "mcp" as const,
    policy: "baseline" as const,
    mcp_profile: "standard" as const,
    feedback: "full" as const,
    name: `baseline-mcp-seed${seed}`,
  };
  const selected = {
    seed,
    interface: "mcp" as const,
    policy: "coverage" as const,
    mcp_profile: profile,
    feedback,
    name: `selected-mcp-seed${seed}`,
  };
  cases.push(...(seed === 2026 ? [baseline, selected] : [selected, baseline]));
  cases.push({
    ...selected,
    interface: "gui",
    name: `selected-gui-seed${seed}`,
  });
}
await mkdir(output);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
await writeFile(
  resolve(output, "manifest.json"),
  JSON.stringify(
    {
      source_commit: sourceCommit,
      clock: "realtime",
      record_video: false,
      duration_seconds: 60,
      model: "gpt-6.1-terra",
      reasoning_effort: "high",
      cases,
      note: "Seeds fixed in OPTIMIZATION.md before development selection. Sequential trials; preserve all outcomes. Common coverage guidance and execution capabilities are shared with GUI.",
    },
    null,
    2,
  ) + "\n",
);
const results = [];
for (const item of cases) {
  const result = await runTrial({
    ...item,
    model: "gpt-6.1-terra",
    output: resolve(output, item.name),
    duration: 60,
    timeout: 180,
    record_video: false,
  });
  results.push({ name: item.name, result });
  await writeFile(
    resolve(output, "results.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
}
if (
  results.some(
    ({ result }) =>
      !result.completed_round || !result.valid_interface || !result.clock_valid,
  )
)
  process.exitCode = 1;
