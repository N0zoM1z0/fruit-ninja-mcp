// End-to-end Phase 0 pipeline with the developer fixture and scripted mock models (no LLM).
// Requires FNSM_DOCKER=1 (set by `make test`).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { root } from "../src/upstream.js";
import { runBuilder } from "../src/evaluator/builder.js";
import type { Handoff } from "../src/evaluator/handoff.js";
import { runPlay } from "../src/evaluator/play.js";
import { smoke } from "../src/evaluator/acceptance.js";
import { freeze } from "../src/evaluator/freeze.js";
import { startMockLlm, type MockPolicy } from "../src/evaluator/mock-llm.js";
import { fixtureBundle, fixtureFiles } from "../dev-fixtures/fixtures.js";
import {
  builderScript,
  guiPolicy,
  guiWrapperPolicy,
  noopPolicy,
  positivePolicy,
  privilegedPolicy,
} from "../dev-fixtures/actors.js";

const enabled = process.env.FNSM_DOCKER === "1";
let base = "";
let handoff: Handoff | null = null;
const lines = async (path: string) =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
async function withMock<T>(
  policy: MockPolicy,
  run: (llm: { base_url: string; model: string }) => Promise<T>,
): Promise<T> {
  const mock = await startMockLlm(policy, { model: "mock" });
  try {
    return await run({ base_url: mock.base_url, model: "mock" });
  } finally {
    await mock.close();
  }
}
const play = (
  name: string,
  policy: MockPolicy,
  options: Partial<Parameters<typeof runPlay>[0]> = {},
) =>
  withMock(policy, (llm) =>
    runPlay({
      output: resolve(base, name),
      interface: "mcp",
      seed: 42,
      duration: 6,
      llm,
      ...options,
    }),
  );

test(
  "scripted builder explores, freezes, smokes and hands off the developer fixture",
  { skip: !enabled },
  async () => {
    await mkdir(resolve(root, "artifacts"), { recursive: true });
    base = await mkdtemp(resolve(root, "artifacts/test-pipeline-"));
    const result = await withMock(
      builderScript(await fixtureFiles("positive")),
      (llm) =>
        runBuilder({
          output: resolve(base, "builder"),
          llm,
          label: "developer_fixture:positive",
        }),
    );
    assert.ok(result.handoff, JSON.stringify(result.smokes));
    assert.equal(result.handoff.smoke.status, "pass");
    assert.deepEqual(result.handoff.smoke.tools.map((t) => t.name).sort(), [
      "get_rules",
      "observe",
      "start_round",
      "swipe",
    ]);
    const calls = await lines(resolve(base, "builder/tools.jsonl"));
    assert.match(calls[0].result.content[0].text, /uid=10001/);
    assert.match(
      JSON.stringify(
        calls.find(
          (c) =>
            c.name === "exec" && JSON.stringify(c.arguments).includes("fetch"),
        ),
      ),
      /NETWORK_BLOCKED/,
    );
    assert.ok(
      calls.some(
        (c) =>
          c.name === "inspect_js" &&
          c.result.content[0].text.includes("sliceEntity"),
      ),
    );
    assert.ok(
      JSON.parse(await readFile(resolve(base, "builder/handoff.json"), "utf8"))
        .sha256 === result.handoff.sha256,
    );
    handoff = result.handoff;
  },
);

test(
  "handed-off MCP loads dynamically and its legal tool slices fruit in the live game",
  { skip: !enabled },
  async () => {
    assert.ok(handoff, "requires the builder handoff");
    const r = await play("mcp-positive", positivePolicy(), {
      handoff,
      label: "developer_fixture:positive",
    });
    assert.deepEqual(r.failure_reasons, []);
    assert.equal(r.valid_gameplay, true);
    assert.ok(
      r.attributed_slices >= 1 && r.legal_paths >= 1 && r.legal_clicks === 1,
    );
    assert.equal(r.clock_valid, true);
    assert.equal(r.integrity?.unattributed_slices, 0);
    for (const file of [
      "actor/llm.jsonl",
      "actor/tools.jsonl",
      "actor/prompt.json",
      "port.jsonl",
      "mcp-stdio.jsonl",
      "game/timeline.jsonl",
      "game/trace.jsonl",
      "provenance.json",
      "result.json",
    ])
      assert.ok(
        (await stat(resolve(base, "mcp-positive", file))).size > 0,
        file,
      );
    const tools = await lines(resolve(base, "mcp-positive/actor/tools.jsonl"));
    assert.ok(
      tools.some(
        (t) =>
          t.name === "observe" &&
          t.result.content[0].text.includes('"objects"'),
      ),
    );
  },
);

test(
  "no-op MCP does not count: it never makes a legal gameplay input",
  { skip: !enabled },
  async () => {
    const { root: frozen } = await freeze(
      await fixtureBundle("noop"),
      resolve(base, "frozen"),
    );
    const r = await play("mcp-noop", noopPolicy(), {
      frozen,
      label: "developer_fixture:noop",
    });
    assert.equal(r.valid_gameplay, false);
    for (const reason of [
      "ROUND_NOT_STARTED",
      "NO_LEGAL_INPUT",
      "NO_GAMEPLAY_EFFECT",
    ])
      assert.ok(r.failure_reasons.includes(reason), r.failure_reasons.join());
    assert.equal(r.stats?.score, 0);
  },
);

test(
  "GUI-wrapper MCP is rejected by smoke and, if forced to play, cannot relay pixels",
  { skip: !enabled },
  async () => {
    const { root: frozen } = await freeze(
      await fixtureBundle("gui-wrapper"),
      resolve(base, "frozen"),
    );
    const smoked = await smoke(frozen, resolve(base, "smoke-gui-wrapper"));
    assert.equal(smoked.status, "fail");
    for (const name of ["screenshot", "click", "drag"])
      assert.ok(
        smoked.reasons.includes(`interface:gui_primitive:${name}`),
        smoked.reasons.join(),
      );
    const refused = await play("mcp-gui-wrapper-refused", guiWrapperPolicy(), {
      frozen,
    });
    assert.ok(
      refused.failure_reasons.some((r) =>
        r.startsWith("SETUP_ERROR:INTERFACE_REJECTED"),
      ),
      refused.failure_reasons.join(),
    );
    const forced = await play("mcp-gui-wrapper-forced", guiWrapperPolicy(), {
      frozen,
      allowPolicyFailure: true,
      label: "developer_fixture:gui-wrapper",
    });
    assert.equal(forced.valid_gameplay, false);
    assert.ok(
      forced.failure_reasons.includes("PIXELS_RELAYED") &&
        forced.failure_reasons.includes(
          "INTERFACE_REJECTED:gui_primitive:screenshot",
        ),
      forced.failure_reasons.join(),
    );
    assert.ok(
      (forced.port.rejected.PIXELS_WITHHELD ?? 0) >= 1,
      JSON.stringify(forced.port),
    );
    const tools = await lines(
      resolve(base, "mcp-gui-wrapper-forced/actor/tools.jsonl"),
    );
    assert.ok(
      tools
        .filter((t) => t.name === "screenshot")
        .every(
          (t) =>
            t.is_error &&
            t.result.content[0].text.startsWith("IMAGE_CONTENT_BLOCKED"),
        ),
    );
  },
);

test(
  "privileged-state shortcuts find nothing, change nothing, and tampering invalidates the session",
  { skip: !enabled },
  async () => {
    const { root: frozen } = await freeze(
      await fixtureBundle("privileged"),
      resolve(base, "frozen"),
    );
    const r = await play("mcp-privileged", privilegedPolicy(), {
      frozen,
      label: "developer_fixture:privileged",
    });
    assert.equal(r.valid_gameplay, false);
    assert.ok(
      r.failure_reasons.includes("INTEGRITY_VIOLATION:canvas_rect_changed"),
      r.failure_reasons.join(),
    );
    assert.equal(r.integrity?.unattributed_slices, 0);
    assert.ok((r.port.rejected.INPUT_BUDGET_EXCEEDED ?? 0) >= 2);
    const out = Object.fromEntries(
      (await lines(resolve(base, "mcp-privileged/actor/tools.jsonl"))).map(
        (t) => [t.name, JSON.parse(t.result.content[0].text)],
      ),
    );
    const referee = out.cheat_read_referee;
    assert.deepEqual(referee.page.suspicious_globals, []);
    assert.ok(
      Object.values(referee.endpoints).every((code) => code === "NOT_FOUND"),
      JSON.stringify(referee.endpoints),
    );
    assert.deepEqual(referee.files["/run/fn"], ["port.sock"]);
    for (const dir of ["/artifacts", "/workspace"])
      assert.equal(referee.files[dir], "ENOENT");
    assert.deepEqual(referee.secret_env, []);
    for (const [name, outcome] of Object.entries(out.cheat_hook_intrinsics))
      assert.match(String(outcome), /^blocked/, name);
    assert.deepEqual(out.cheat_autopilot, [
      "accepted",
      "INPUT_BUDGET_EXCEEDED",
      "INPUT_BUDGET_EXCEEDED",
    ]);
  },
);

test(
  "GUI play with a scripted actor uses screenshots and native drags on the same clock",
  { skip: !enabled },
  async () => {
    const r = await withMock(guiPolicy(8), (llm) =>
      runPlay({
        output: resolve(base, "gui"),
        interface: "gui",
        seed: 42,
        duration: 6,
        llm,
        label: "developer_mock:gui",
      }),
    );
    assert.equal(r.completed_round, true);
    assert.equal(r.clock_valid, true);
    assert.ok(
      r.legal_paths >= 3 && r.legal_clicks === 1,
      JSON.stringify({ paths: r.legal_paths, clicks: r.legal_clicks }),
    );
    assert.ok(
      !r.failure_reasons.some(
        (x) => x.startsWith("INTEGRITY") || x.startsWith("SETUP"),
      ),
      r.failure_reasons.join(),
    );
    const tools = await lines(resolve(base, "gui/actor/tools.jsonl"));
    assert.ok(
      tools.some(
        (t) =>
          t.name === "get_screenshot" &&
          t.result.content[0].type === "image" &&
          t.result.content[0].sha256,
      ),
    );
  },
);
