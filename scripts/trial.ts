import { parseArgs } from "node:util";
import { runTrial } from "../src/trial.js";
import type { Interface } from "../src/types.js";
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    interface: { type: "string", default: "mcp" },
    model: { type: "string", default: "gpt-6.1-terra" },
    seed: { type: "string", default: "42" },
    duration: { type: "string", default: "60" },
    timeout: { type: "string", default: "180" },
  },
});
const result = await runTrial({
  output:
    values.output ??
    `artifacts/realtime/${new Date().toISOString().replace(/[:.]/g, "-")}`,
  interface: values.interface as Interface,
  model: values.model!,
  seed: Number(values.seed),
  duration: Number(values.duration),
  timeout: Number(values.timeout),
});
if (!result.completed_round || !result.valid_interface || !result.clock_valid)
  process.exitCode = 1;
