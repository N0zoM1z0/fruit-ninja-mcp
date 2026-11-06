// One-command Phase 0 smoke and video preview (developer fixture + mock models, no LLM):
// scripted builder -> frozen fixture handoff -> generated-MCP play -> GUI play -> MP4 export.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runBuilder } from "../src/evaluator/builder.js";
import { runPlay } from "../src/evaluator/play.js";
import { exportVideo } from "../src/evaluator/video.js";
import { startMockLlm } from "../src/evaluator/mock-llm.js";
import { provenance } from "../src/evaluator/provenance.js";
import { fixtureFiles } from "../dev-fixtures/fixtures.js";
import {
  builderScript,
  guiPolicy,
  positivePolicy,
} from "../dev-fixtures/actors.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    seed: { type: "string", default: "42" },
    duration: { type: "string", default: "10" },
    "no-video": { type: "boolean", default: false },
  },
});
const out = resolve(
  values.output ??
    `artifacts/preview/${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
await mkdir(out, { recursive: true });
const seed = Number(values.seed),
  duration = Number(values.duration),
  video = !values["no-video"];

const builderModel = await startMockLlm(
  builderScript(await fixtureFiles("positive")),
  { model: "mock-builder-script" },
);
const built = await runBuilder({
  output: resolve(out, "builder"),
  llm: { base_url: builderModel.base_url, model: "mock-builder-script" },
  label: "developer_fixture:positive",
}).finally(builderModel.close);
if (!built.handoff)
  throw new Error(
    `Scripted builder did not hand off: ${JSON.stringify(built.smokes)}`,
  );

const summarize = (r: Awaited<ReturnType<typeof runPlay>>) => ({
  score: r.score,
  sliced: r.stats?.sliced ?? null,
  bombs_hit: r.stats?.bombs_hit ?? null,
  legal_paths: r.legal_paths,
  completed_round: r.completed_round,
  clock_valid: r.clock_valid,
  valid_gameplay: r.valid_gameplay,
  failure_reasons: r.failure_reasons,
  tool_calls: r.agent?.tool_calls ?? 0,
});
const mcpModel = await startMockLlm(positivePolicy(), {
  model: "mock-positive-actor",
});
const mcp = await runPlay({
  output: resolve(out, "mcp"),
  interface: "mcp",
  frozen: built.handoff.frozen,
  seed,
  duration,
  llm: { base_url: mcpModel.base_url, model: "mock-positive-actor" },
  recordVideo: video,
  label: "developer_fixture:positive",
}).finally(mcpModel.close);
const guiModel = await startMockLlm(guiPolicy(Math.ceil(duration * 1.2)), {
  model: "mock-gui-actor",
});
const gui = await runPlay({
  output: resolve(out, "gui"),
  interface: "gui",
  seed,
  duration,
  llm: { base_url: guiModel.base_url, model: "mock-gui-actor" },
  recordVideo: video,
  label: "developer_mock:gui",
}).finally(guiModel.close);
const videos = video
  ? {
      mcp: mcp.completed_round
        ? (await exportVideo(resolve(out, "mcp"))).output
        : null,
      gui: gui.completed_round
        ? (await exportVideo(resolve(out, "gui"))).output
        : null,
    }
  : null;
const summary = {
  note: "Phase 0 infrastructure preview: developer fixture MCP and scripted mock actors. Not a model result or benchmark score.",
  provenance: await provenance({ role: "preview" }),
  builder: {
    handoff: built.handoff.sha256,
    smoke: built.handoff.smoke.status,
    tools: built.handoff.smoke.tools.map((t) => t.name),
    controller_calls: built.agent.tool_calls,
  },
  mcp: summarize(mcp),
  gui: summarize(gui),
  videos,
  output: out,
};
await writeFile(
  resolve(out, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(JSON.stringify(summary, null, 2));
if (!mcp.valid_gameplay || !gui.completed_round) process.exitCode = 1;
