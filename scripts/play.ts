// GUI-play or generated-MCP-play of one realtime round.
//   npm run play -- --interface gui --mock gui --seed 42 --duration 20 --output artifacts/play-gui
//   npm run play -- --interface mcp --handoff artifacts/build-x/handoff.json --llm-base-url URL --llm-model M
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { runPlay } from "../src/evaluator/play.js";
import { exportVideo } from "../src/evaluator/video.js";
import {
  guiPolicy,
  guiWrapperPolicy,
  noopPolicy,
  positivePolicy,
  privilegedPolicy,
} from "../dev-fixtures/actors.js";
import { endpoint, llmOptions } from "./llm-args.js";

const { values } = parseArgs({
  options: {
    ...llmOptions,
    interface: { type: "string", default: "gui" },
    frozen: { type: "string" },
    handoff: { type: "string" },
    seed: { type: "string", default: "42" },
    duration: { type: "string", default: "60" },
    profile: { type: "string", default: "standard" },
    output: { type: "string" },
    "record-video": { type: "boolean", default: false },
    "export-video": { type: "boolean", default: false },
    "max-steps": { type: "string" },
    timeout: { type: "string" },
    "allow-policy-failure": { type: "boolean", default: false },
  },
});
if (values.frozen !== undefined && values.handoff !== undefined)
  throw new Error("choose either --handoff replay or a raw --frozen fixture");
const handoff = values.handoff
  ? JSON.parse(await readFile(values.handoff, "utf8"))
  : undefined;
const { llm, close } = await endpoint(values, {
  gui: () => guiPolicy(),
  positive: () => positivePolicy(),
  noop: noopPolicy,
  "gui-wrapper": guiWrapperPolicy,
  privileged: privilegedPolicy,
});
const output =
  values.output ??
  `artifacts/play/${new Date().toISOString().replace(/[:.]/g, "-")}-${values.interface}`;
try {
  const result = await runPlay({
    output,
    interface: values.interface as "gui" | "mcp",
    frozen: values.frozen,
    handoff,
    seed: Number(values.seed),
    duration: Number(values.duration),
    profile: values.profile as "standard" | "async",
    llm,
    maxSteps: values["max-steps"] ? Number(values["max-steps"]) : undefined,
    timeoutSeconds: values.timeout ? Number(values.timeout) : undefined,
    recordVideo: values["record-video"] || values["export-video"],
    allowPolicyFailure: values["allow-policy-failure"],
    label: values.mock ? `developer_mock:${values.mock}` : undefined,
  });
  const { final_scene: _, ...summary } = result;
  void _;
  console.log(JSON.stringify(summary, null, 2));
  if (values["export-video"] && result.completed_round)
    console.log(JSON.stringify(await exportVideo(output), null, 2));
  if (!result.valid_gameplay) process.exitCode = 1;
} finally {
  await close();
}
