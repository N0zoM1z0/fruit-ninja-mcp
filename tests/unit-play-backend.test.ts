import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeBackend } from "../src/evaluator/play.js";
import { PortError } from "../src/public/port.js";
import type { GameRuntime } from "../src/runtime.js";

const points = [
  { x: 100, y: 100, t_ms: 0 },
  { x: 200, y: 100, t_ms: 100 },
];
const busy = (error: unknown) =>
  error instanceof PortError && error.code === "BUSY";

for (const profile of ["standard", "async"] as const) {
  test(
    `${profile}: a blocking path reserves input until completion and rejects overlaps`,
    { timeout: 2000 },
    async () => {
      let finish!: (value: any) => void;
      let paths = 0;
      let clicks = 0;
      const runtime = {
        actionStatus: () => ({ pending_action: null, previous_action: null }),
        portPath: () => {
          paths++;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        click: async () => {
          clicks++;
        },
      } as unknown as GameRuntime;
      const backend = new RuntimeBackend(runtime, profile);
      const first = backend.path(points, true);
      await assert.rejects(backend.path(points, true), busy);
      await assert.rejects(backend.path(points, false), busy);
      await assert.rejects(backend.click(100, 100), busy);
      assert.equal(paths, 1);
      assert.equal(clicks, 0);
      finish({ actual_duration_ms: 100 });
      await first;
      await backend.click(100, 100);
      assert.equal(clicks, 1);
    },
  );
}

test(
  "an acknowledged async path still blocks blocking paths and clicks until mouse-up",
  { timeout: 2000 },
  async () => {
    let pending = false;
    let paths = 0;
    const runtime = {
      actionStatus: () => ({
        pending_action: pending ? { action_id: 1 } : null,
        previous_action: null,
      }),
      submitPath: async () => {
        pending = true;
        return { accepted: true, action_id: 1 };
      },
      portPath: async () => {
        paths++;
        return { actual_duration_ms: 100 };
      },
    } as unknown as GameRuntime;
    const backend = new RuntimeBackend(runtime, "async");
    await backend.path(points, false);
    await assert.rejects(backend.path(points, true), busy);
    await assert.rejects(backend.path(points, false), busy);
    await assert.rejects(backend.click(100, 100), busy);
    assert.equal(paths, 0);
    pending = false;
    await backend.path(points, true);
    assert.equal(paths, 1);
  },
);
