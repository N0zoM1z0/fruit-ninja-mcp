// Compatibility of the frozen Phase 1 MCP (evidence, read-only) with the English evaluation
// build. A scripted actor drives its own tools; no model is called. Requires FNSM_DOCKER=1.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { root } from "../src/upstream.js";
import { verifyFrozen } from "../src/evaluator/freeze.js";
import { runPlay } from "../src/evaluator/play.js";
import { startMockLlm } from "../src/evaluator/mock-llm.js";

const enabled = process.env.FNSM_DOCKER === "1";
const handoff = resolve(root, "evidence/phase1/pilot-1/handoff");
const sha = "c34c30daa3e8dfbb5cf909d5ab945a8918244a396dfba6b61448eb59dc175b46";

test(
  "the frozen Phase 1 MCP still starts, observes and slices in the English game",
  { skip: !enabled },
  async () => {
    await verifyFrozen(handoff, sha);
    let slices = 0;
    const mock = await startMockLlm(({ step, results }) => {
      const last = results.at(-1) ?? "";
      if (step === 1) return { tool_calls: [{ name: "game_state" }] };
      if (step === 2) return { tool_calls: [{ name: "start_round" }] };
      if (step === 3) return { tool_calls: [{ name: "game_state" }] };
      if (last.includes('"phase":"result"') || slices >= 40)
        return slices < 99
          ? ((slices = 99), { tool_calls: [{ name: "game_state" }] })
          : { content: "done" };
      slices++;
      return { tool_calls: [{ name: "slice" }] };
    });
    await mkdir(resolve(root, "artifacts"), { recursive: true });
    const output = resolve(
      await mkdtemp(resolve(root, "artifacts/test-phase1-")),
      "play",
    );
    try {
      const r = await runPlay({
        output,
        interface: "mcp",
        frozen: handoff,
        seed: 42,
        duration: 10,
        llm: { base_url: mock.base_url, model: "scripted" },
        label: "phase1-mcp-compat",
      });
      assert.deepEqual(r.failure_reasons, []);
      assert.ok(
        r.attributed_slices >= 1 && r.legal_paths >= 1,
        JSON.stringify({ slices: r.attributed_slices, paths: r.legal_paths }),
      );
      const states = (
        await readFile(resolve(output, "actor/tools.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .filter((t) => t.name === "game_state")
        .map((t) => JSON.parse(t.result.content[0].text));
      const phase = (s: any) => s.phase ?? s.state?.phase;
      assert.equal(phase(states[0]), "menu");
      assert.equal(phase(states[1]), "playing");
      assert.equal(phase(states.at(-1)), "result");
      // Known effect: the adapter matched Chinese mode labels, so English builds report mode null.
      assert.equal(states[1].mode ?? states[1].state?.mode ?? null, null);
    } finally {
      await mock.close();
    }
    await verifyFrozen(handoff, sha); // evidence is mounted read-only and stays byte-identical
  },
);
