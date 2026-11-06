import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GameRuntime } from "../src/runtime.js";

test("telemetry records sample receipt before a delayed persistence queue", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "fruit-telemetry-"));
  const game = await GameRuntime.launch({ artifacts: directory });
  let release!: () => void;
  try {
    await game.prepare({ mode: "arcade", seed: 42, duration_seconds: 5 });
    await game.start();
    await (game as any).persistence;
    (game as any).persistence = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scene = await game.scene();
    const saving = (game as any).persist(scene);
    await sleep(300);
    release();
    await saving;
    const rows = (await readFile(resolve(directory, "timeline.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const row = rows.find(
      (row) =>
        row.scene.clock_audit.observed_at_ms ===
        scene.clock_audit.observed_at_ms,
    );
    assert.ok(row);
    assert.ok(row.persisted_host_ms - row.host_ms >= 250);
    const current = await game.scene();
    assert.ok(current.elapsed_ms - scene.elapsed_ms >= 250);
  } finally {
    release?.();
    await game.close();
    await rm(directory, { recursive: true, force: true });
  }
});
