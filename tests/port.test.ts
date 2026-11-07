import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { GameRuntime } from "../src/runtime.js";
import { root } from "../src/upstream.js";
import { startPort } from "../src/public/port.js";
import { GamePortClient } from "../src/public/port-client.js";
import { CallGate, RuntimeBackend } from "../src/evaluator/play.js";

test("game port: legal native input changes the live game; budget, pixels and hidden routes are refused", async () => {
  const g = await GameRuntime.launch();
  const gate = new CallGate();
  const socket = resolve(
    await mkdtemp(resolve(tmpdir(), "fnsm-port-")),
    "port.sock",
  );
  let port: Awaited<ReturnType<typeof startPort>> | undefined;
  try {
    await g.prepare({ mode: "arcade", seed: 42, duration_seconds: 8 });
    await g.injectAdapter(
      await readFile(resolve(root, "dev-fixtures/mcp/adapter.js"), "utf8"),
    );
    port = await startPort({
      socketPath: socket,
      backend: new RuntimeBackend(g, "standard"),
      gate,
    });
    const client = new GamePortClient(socket);
    const info = await client.info();
    assert.equal(info.ok, true);
    assert.deepEqual((info.adapter as any).exports.sort(), [
      "locate_start",
      "observe",
      "snapshot",
    ]);
    assert.equal(
      (await client.call("GET", "/v1/scene")).error?.code,
      "NOT_FOUND",
    );
    const start = (await client.adapter("locate_start")).value as {
      x: number;
      y: number;
    };
    assert.equal(
      (await client.click(start.x, start.y)).error?.code,
      "NO_ACTIVE_TOOL_CALL",
    );
    gate.begin(1);
    assert.equal((await client.click(start.x, start.y)).ok, true);
    assert.equal(
      (await client.click(start.x, start.y)).error?.code,
      "INPUT_BUDGET_EXCEEDED",
    );
    gate.end(1);
    assert.equal((await g.scene()).phase, "playing");
    assert.equal(
      (await client.adapter("snapshot")).error?.code,
      "PIXELS_WITHHELD",
    );

    // The render-hook observation agrees with referee state (test oracle) and drives a legal slice.
    let sliced = 0;
    for (let call = 2; call < 40 && !sliced; call++) {
      const seen = (await client.adapter("observe")).value as any;
      const target = seen.objects.find((o: any) => o.y > 250 && o.y < 820);
      if (!target) {
        await sleep(60);
        continue;
      }
      const t = 0.1,
        x = target.x + target.vx * t,
        y = target.y + target.vy * t + 0.5 * 1.03 * seen.canvas.height * t * t;
      gate.begin(call);
      const reply = await client.path([
        { x: Math.max(1, x - 140), y, t_ms: 0 },
        { x: Math.min(1439, x + 140), y, t_ms: 90 },
      ]);
      gate.end(call);
      assert.equal(reply.ok, true, JSON.stringify(reply));
      for (const key of ["scene", "events", "stats", "objects"])
        assert.equal(key in reply, false, `port leaked ${key}`);
      sliced = (await g.scene()).stats.sliced;
    }
    assert.ok(
      sliced >= 1,
      "adapter observation plus native path slices real fruit",
    );
    assert.equal((await g.integrity()).unattributed_slices, 0);
    gate.begin(99);
    assert.equal(
      (
        await client.path([
          { x: 0, y: 0, t_ms: 0 },
          { x: 1400, y: 0, t_ms: 20 },
        ])
      ).error?.code,
      "INVALID_PATH",
    );
    gate.end(99);
  } finally {
    await port?.close();
    await g.close();
  }
});
