import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { interfacePolicy, resultViolations } from "../src/evaluator/policy.js";
import {
  freeze,
  validateBundle,
  verifyFrozen,
} from "../src/evaluator/freeze.js";
import { checkAdapterResult } from "../src/public/port.js";
import { CallGate } from "../src/evaluator/play.js";
import { fixtureBundle } from "../dev-fixtures/fixtures.js";

const tool = (
  name: string,
  properties: Record<string, object> = {},
  description = "",
) => ({
  name,
  description,
  inputSchema: { type: "object" as const, properties },
});
const manifest = (...names: string[]) => ({
  tools: names.map((name) => ({ name, mechanism: "test" })),
});

test("interface policy accepts application tools and rejects GUI primitives, executors and code arguments", () => {
  assert.deepEqual(
    interfacePolicy(
      [tool("observe"), tool("swipe", { points: { type: "array" } })],
      manifest("observe", "swipe"),
    ).reasons,
    [],
  );
  const gui = interfacePolicy(
    [tool("screenshot"), tool("click", { x: {}, y: {} }), tool("drag")],
    manifest("screenshot", "click", "drag"),
  );
  assert.deepEqual(gui.reasons.sort(), [
    "gui_primitive:click",
    "gui_primitive:drag",
    "gui_primitive:screenshot",
  ]);
  assert.ok(
    interfacePolicy([tool("exec")], manifest("exec")).reasons.includes(
      "code_execution:exec",
    ),
  );
  assert.ok(
    interfacePolicy(
      [
        tool("query", {
          options: { type: "object", properties: { script: {} } },
        }),
      ],
      manifest("query"),
    ).reasons.includes("code_argument:query.options.script"),
  );
  assert.ok(
    interfacePolicy(
      [tool("helper", {}, "Evaluate arbitrary JavaScript in the page")],
      manifest("helper"),
    ).reasons.includes("code_description:helper"),
  );
  assert.ok(
    interfacePolicy(
      [tool("observe")],
      manifest("observe", "missing"),
    ).reasons.includes("manifest_tools_mismatch"),
  );
  assert.ok(
    interfacePolicy([tool("raw")], {
      tools: [{ name: "raw", mechanism: "x", free_form: true }],
    }).reasons.includes("review_required:raw"),
  );
});

test("tool results that relay pixels are dynamic GUI-wrapper violations", () => {
  assert.deepEqual(
    resultViolations({
      content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
    }),
    ["image_content"],
  );
  assert.deepEqual(
    resultViolations({
      content: [{ type: "text", text: '{"img":"data:image/png;base64,AAAA"}' }],
    }),
    ["image_data_url"],
  );
  assert.deepEqual(
    resultViolations({ content: [{ type: "text", text: '{"objects":[]}' }] }),
    [],
  );
});

test("game port withholds pixels and bounds adapter results", () => {
  assert.equal(
    checkAdapterResult({ objects: [{ x: 1 }] }),
    '{"objects":[{"x":1}]}',
  );
  assert.throws(
    () => checkAdapterResult("data:image/png;base64,AAAA"),
    /PIXELS_WITHHELD/,
  );
  assert.throws(
    () => checkAdapterResult({ frame: "A".repeat(5000) }),
    /PIXELS_WITHHELD/,
  );
  assert.throws(
    () => checkAdapterResult({ big: "x ".repeat(200_000) }),
    /RESULT_TOO_LARGE/,
  );
});

test("one native input per actor tool call, none outside a call", () => {
  const gate = new CallGate();
  assert.throws(() => gate.authorize(), /NO_ACTIVE_TOOL_CALL/);
  gate.begin(1);
  gate.authorize();
  assert.throws(() => gate.authorize(), /INPUT_BUDGET_EXCEEDED/);
  gate.end(1);
  assert.throws(() => gate.authorize(), /NO_ACTIVE_TOOL_CALL/);
  gate.begin(2);
  gate.authorize();
});

test("freeze validates deliverables, hashes them immutably and detects tampering", async () => {
  const bundle = await fixtureBundle("positive");
  const dir = await mkdtemp(resolve(tmpdir(), "fnsm-freeze-"));
  const { root, record } = await freeze(bundle, dir);
  assert.match(record.sha256, /^[0-9a-f]{64}$/);
  assert.equal(record.adapter?.path, "mcp/adapter.js");
  assert.equal((await verifyFrozen(root)).sha256, record.sha256);
  assert.equal(
    (await freeze(bundle, dir)).record.sha256,
    record.sha256,
    "freezing is deterministic",
  );
  const launch = resolve(root, "mcp/launch.sh");
  await writeFile(launch, (await readFile(launch, "utf8")) + "# tampered\n");
  await chmod(launch, 0o755);
  await assert.rejects(
    verifyFrozen(root),
    /frozen bytes or mode changed: mcp\/launch.sh/,
  );
  const extra = await freeze(await fixtureBundle("noop"), dir);
  await symlink("/etc/passwd", resolve(extra.root, "mcp/link"));
  await assert.rejects(verifyFrozen(extra.root), /links and special files/);

  const broken = structuredClone(bundle);
  delete broken.files["intermediate/NOTE.md"];
  assert.throws(() => validateBundle(broken), /intermediate/);
  const unsafe = structuredClone(bundle);
  unsafe.files["mcp/../../etc/x"] = { mode: 0o644, base64: "" };
  assert.throws(() => validateBundle(unsafe), /unsafe artifact path/);
  const mode = structuredClone(bundle);
  mode.files["mcp/launch.sh"].mode = 0o644;
  assert.throws(() => validateBundle(mode), /executable/);
  const badAdapter = structuredClone(bundle);
  badAdapter.files["mcp/adapter.js"].base64 =
    Buffer.from("exports.x = (").toString("base64");
  assert.throws(() => validateBundle(badAdapter), /adapter does not parse/);
});
