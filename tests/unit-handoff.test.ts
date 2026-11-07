import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fixtureBundle } from "../dev-fixtures/fixtures.js";
import {
  freeze,
  inventoryDigest,
  verifyFrozen,
} from "../src/evaluator/freeze.js";
import { verifyHandoff, type Handoff } from "../src/evaluator/handoff.js";
import { runPlay } from "../src/evaluator/play.js";
import { root } from "../src/upstream.js";

async function fixture() {
  await mkdir(resolve(root, "artifacts"), { recursive: true });
  const dir = await mkdtemp(resolve(root, "artifacts/test-handoff-"));
  const frozen = await freeze(await fixtureBundle("positive"), dir);
  const handoff: Handoff = {
    sha256: frozen.record.sha256,
    frozen: frozen.root,
    smoke: {
      status: "pass",
      artifact: frozen.record.sha256,
      reasons: [],
      tools: frozen.record.manifest.tools.map((t) => ({ name: t.name })),
      policy: {
        ok: true,
        reasons: [],
        tools: frozen.record.manifest.tools.map((t) => t.name),
      },
      adapter_exports: [],
      stdout_violations: [],
      stderr_tail: "",
      stdio_tail: "",
      duration_ms: 1,
    },
    notes: null,
    builder_run: dir,
    handed_off_at: new Date().toISOString(),
  };
  return { ...frozen, dir, handoff };
}

test("handoff replay requires matching identity and passing smoke before starting playback", async () => {
  const f = await fixture();
  assert.deepEqual((await verifyHandoff(f.handoff)).record, f.record);
  const cases: [string, (h: Handoff) => void, RegExp][] = [
    [
      "digest",
      (h) => {
        h.sha256 = h.smoke.artifact = "0".repeat(64);
      },
      /handoff artifact digest mismatch/,
    ],
    [
      "failed smoke",
      (h) => {
        h.smoke.status = "fail";
      },
      /passing smoke/,
    ],
    [
      "smoke artifact",
      (h) => {
        h.smoke.artifact = "1".repeat(64);
      },
      /smoke artifact mismatch/,
    ],
    [
      "audit reproduction",
      (h) => {
        h.sha256 = "0".repeat(64);
        h.smoke = {
          status: "fail",
          artifact: "1".repeat(64),
        } as Handoff["smoke"];
      },
      /passing smoke/,
    ],
    [
      "contradictory smoke",
      (h) => {
        h.smoke.reasons.push("initialize failed");
      },
      /passing smoke/,
    ],
    [
      "failed policy",
      (h) => {
        h.smoke.policy!.ok = false;
      },
      /passing smoke/,
    ],
    [
      "missing smoke",
      (h) => {
        delete (h as Partial<Handoff>).smoke;
      },
      /passing smoke/,
    ],
  ];
  for (const [name, mutate, error] of cases) {
    const handoff = structuredClone(f.handoff);
    mutate(handoff);
    const output = resolve(f.dir, name);
    await assert.rejects(
      runPlay({
        output,
        interface: "mcp",
        handoff,
        seed: 42,
        duration: 5,
        llm: { base_url: "http://127.0.0.1:1", model: "unused" },
      }),
      error,
      name,
    );
    assert.equal(
      existsSync(output),
      false,
      "reject before browser, MCP, or LLM setup",
    );
  }
  await assert.rejects(
    runPlay({
      output: resolve(f.dir, "ambiguous"),
      interface: "mcp",
      handoff: f.handoff,
      frozen: f.root,
      seed: 42,
      duration: 5,
      llm: { base_url: "http://127.0.0.1:1", model: "unused" },
    }),
    /choose either/,
  );
});

test("frozen metadata is derived from verified bytes and inconsistent copies are rejected", async () => {
  const f = await fixture();
  const build = resolve(f.root, "build.json");
  const original = await readFile(build, "utf8");
  const cases: [string, (record: typeof f.record) => void][] = [
    [
      "adapter removed",
      (r) => {
        r.adapter = null;
      },
    ],
    [
      "mechanism replaced",
      (r) => {
        r.manifest.tools[0].mechanism = "AUDIT_METADATA_REPLACEMENT";
      },
    ],
    [
      "adapter redirected",
      (r) => {
        r.adapter!.path = "mcp/server.mjs";
      },
    ],
    [
      "adapter digest",
      (r) => {
        r.adapter!.sha256 = "0".repeat(64);
      },
    ],
    [
      "audit reproduction",
      (r) => {
        r.adapter = null;
        r.manifest.tools[0].mechanism = "AUDIT_METADATA_REPLACEMENT";
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    const record = JSON.parse(original);
    mutate(record);
    await writeFile(build, JSON.stringify(record));
    await assert.rejects(
      verifyFrozen(f.root),
      /frozen metadata mismatch/,
      name,
    );
    await assert.rejects(
      verifyHandoff(f.handoff),
      /frozen metadata mismatch/,
      name,
    );
  }
  // A consistent inventory digest must also bind the actual byte count.
  const record = JSON.parse(original);
  record.files["manifest.json"].bytes++;
  record.sha256 = inventoryDigest(record.files);
  await writeFile(build, JSON.stringify(record));
  await assert.rejects(verifyFrozen(f.root), /frozen bytes or mode changed/);
  await writeFile(build, original);
  const verified = await verifyFrozen(f.root);
  assert.deepEqual(
    verified.manifest,
    JSON.parse(await readFile(resolve(f.root, "manifest.json"), "utf8")),
  );
  assert.equal(
    verified.adapter!.sha256,
    verified.files[verified.adapter!.path].sha256,
  );
  assert.deepEqual((await verifyHandoff(f.handoff)).record, verified);
});

test("play CLI forwards the full handoff and rejects inconsistent replay records", async () => {
  const f = await fixture();
  for (const failedSmoke of [false, true]) {
    const handoff = structuredClone(f.handoff);
    handoff.sha256 = "0".repeat(64);
    handoff.smoke.artifact = handoff.sha256;
    if (failedSmoke) handoff.smoke.status = "fail";
    const path = resolve(f.dir, `handoff-${failedSmoke}.json`);
    const output = resolve(f.dir, `play-${failedSmoke}`);
    await writeFile(path, JSON.stringify(handoff));
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve(root, "scripts/play.ts"),
          "--interface",
          "mcp",
          "--handoff",
          path,
          "--mock",
          "positive",
          "--duration",
          "5",
          "--max-steps",
          "1",
          "--output",
          output,
        ],
        { cwd: root },
      ),
      (error: any) => {
        assert.equal(error.code, 1);
        assert.match(
          error.stderr,
          failedSmoke
            ? /handoff requires a passing smoke/
            : /handoff artifact digest mismatch/,
        );
        return true;
      },
    );
    assert.equal(existsSync(output), false);
  }
});
