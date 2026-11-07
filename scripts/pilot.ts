// Phase 1 pilot: one real builder session, then generated-MCP play and GUI play with the same
// model, settings, seed, duration and rules. No developer fixtures or mock models. Every
// outcome, including failures, is written to summary.json next to the full run directories.
//   make pilot ARGS="--llm-config config/deepseek-v4.1-flash.json --output artifacts/phase1/pilot-1"
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runBuilder, type BuilderResult } from "../src/evaluator/builder.js";
import { runPlay } from "../src/evaluator/play.js";
import { exportVideo } from "../src/evaluator/video.js";
import { provenance } from "../src/evaluator/provenance.js";
import type { AgentResult } from "../src/evaluator/llm.js";
import { endpoint, llmOptions } from "./llm-args.js";

const { values } = parseArgs({
  options: {
    ...llmOptions,
    output: { type: "string" },
    seed: { type: "string", default: "42" },
    duration: { type: "string", default: "60" },
    "builder-max-tokens": { type: "string" },
    "builder-max-steps": { type: "string", default: "200" },
    "builder-timeout": { type: "string", default: "10800" },
    handoff: { type: "string" },
  },
});
if (values.mock)
  throw new Error("The pilot uses a real model; mocks are for Phase 0 only");
const out = resolve(
  values.output ??
    `artifacts/phase1/pilot-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
await mkdir(out, { recursive: true });
const { llm } = await endpoint(values, {});
const seed = Number(values.seed),
  duration = Number(values.duration);
const builderLlm = {
  ...llm,
  ...(values["builder-max-tokens"]
    ? { max_tokens: Number(values["builder-max-tokens"]) }
    : {}),
};
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
};
const agentSummary = (a: AgentResult | null | undefined) =>
  a && {
    stop_reason: a.stop_reason,
    error: a.error ?? null,
    steps: a.steps,
    tool_calls: a.tool_calls,
    tool_errors: a.tool_errors,
    usage: a.usage,
    finish_reasons: a.finish_reasons,
    truncations: a.truncations,
    compactions: a.compactions,
    llm_latency_ms: {
      n: a.llm_latency_ms.length,
      median: quantile(a.llm_latency_ms, 0.5),
      p90: quantile(a.llm_latency_ms, 0.9),
      max: quantile(a.llm_latency_ms, 1),
    },
  };
const summary: Record<string, unknown> = {
  note: "Phase 1 pilot: one real builder session and one round per interface. Not a benchmark.",
  provenance: await provenance({ role: "phase1-pilot" }),
  model: { ...llm, api_key_env: llm.api_key_env ?? null },
  builder_max_tokens: builderLlm.max_tokens ?? null,
  game: { mode: "arcade", seed, duration_seconds: duration },
};
const save = () =>
  writeFile(
    resolve(out, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );

// 1. Builder (or a previously recorded handoff, reused only after an infrastructure fault).
let handoff: BuilderResult["handoff"] = null;
if (values.handoff) {
  handoff = JSON.parse(await readFile(values.handoff, "utf8"));
  summary.builder = {
    reused_handoff: resolve(values.handoff),
    sha256: handoff?.sha256 ?? null,
  };
} else {
  try {
    const built = await runBuilder({
      output: resolve(out, "builder"),
      llm: builderLlm,
      maxSteps: Number(values["builder-max-steps"]),
      timeoutSeconds: Number(values["builder-timeout"]),
      label: "phase1_pilot",
    });
    handoff = built.handoff;
    summary.builder = {
      handoff: handoff?.sha256 ?? null,
      smoke: handoff?.smoke.status ?? null,
      tools: handoff?.smoke.tools.map((t) => t.name) ?? [],
      frozen: built.frozen,
      smokes: built.smokes,
      wall_seconds: built.wall_seconds,
      agent: agentSummary(built.agent),
    };
  } catch (error) {
    summary.builder = {
      error: String(error instanceof Error ? error.stack : error),
    };
  }
}
await save();

// 2 and 3. Same model, seed, duration, rules and recording for both interfaces.
const play = async (name: "mcp" | "gui") => {
  if (name === "mcp" && !handoff)
    return {
      skipped: "no builder handoff; the MCP condition counts as failed",
    };
  try {
    const r = await runPlay({
      output: resolve(out, name),
      interface: name,
      ...(name === "mcp" ? { handoff: handoff! } : {}),
      seed,
      duration,
      llm,
      recordVideo: true,
      label: "phase1_pilot",
    });
    let video: unknown = null;
    if (r.completed_round)
      try {
        const e = await exportVideo(resolve(out, name));
        video = {
          mp4: e.output,
          sha256: e.output_sha256,
          duration_seconds: e.validation.duration_seconds,
          all_source_frames_retained: e.validation.all_source_frames_retained,
        };
      } catch (error) {
        video = { error: String(error) };
      }
    return {
      score: r.score,
      stats: r.stats,
      valid_gameplay: r.valid_gameplay,
      failure_reasons: r.failure_reasons,
      completed_round: r.completed_round,
      clock_valid: r.clock_valid,
      max_clock_drift_ms: r.maximum_telemetry_clock_drift_ms,
      legal_paths: r.legal_paths,
      legal_clicks: r.legal_clicks,
      attributed_slices: r.attributed_slices,
      integrity_violations: r.integrity?.violations ?? null,
      port: r.port,
      agent: agentSummary(r.agent),
      wall_seconds: r.wall_seconds,
      video,
    };
  } catch (error) {
    return { error: String(error instanceof Error ? error.stack : error) };
  }
};
summary.mcp = await play("mcp");
await save();
summary.gui = await play("gui");
await save();
console.log(JSON.stringify(summary, null, 2));
