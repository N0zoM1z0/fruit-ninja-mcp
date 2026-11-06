import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GameRuntime } from "../src/runtime.js";
import { buildServer } from "../src/server.js";
import { enrichObservation } from "../src/observation.js";
import type { Scene } from "../src/types.js";

test("new-fruit observation waits for visible entry without stopping the clock", async () => {
  const game = await GameRuntime.launch();
  try {
    await game.prepare({ mode: "arcade", seed: 42, duration_seconds: 5 });
    await game.start();
    const start = performance.now(),
      first = await game.observe({ until: "new_fruit", timeout_ms: 1000 });
    assert.equal(first.trigger, "new_fruit");
    assert.ok(first.waited_ms > 30 && first.waited_ms < 600);
    assert.ok(
      Math.abs(first.scene.elapsed_ms - (performance.now() - start)) < 100,
    );
    const firstIds = new Set(first.scene.objects.map((e) => e.id));
    for (const id of first.new_fruit_ids) {
      const object = first.scene.objects.find((e) => e.id === id)!;
      assert.ok(object);
      assert.ok(object.y - object.radius < first.scene.arena.height);
    }
    const second = await game.observe({ until: "new_fruit", timeout_ms: 2200 });
    assert.equal(second.trigger, "new_fruit");
    assert.ok(second.waited_ms > 800);
    assert.ok(second.new_fruit_ids.every((id) => !firstIds.has(id)));
    const timeout = await game.observe({ until: "new_fruit", timeout_ms: 40 });
    assert.equal(timeout.trigger, "timeout");
    assert.ok(timeout.waited_ms >= 35);
    assert.ok(timeout.scene.elapsed_ms > second.scene.elapsed_ms);
  } finally {
    await game.close();
  }
});
test("fresh observation before starting returns ready without inventing a wave", async () => {
  const game = await GameRuntime.launch();
  try {
    await game.prepare({ mode: "arcade", seed: 42, duration_seconds: 5 });
    const result = await game.observe({ until: "new_fruit", timeout_ms: 1000 });
    assert.equal(result.trigger, "not_started");
    assert.equal(result.scene.elapsed_ms, 0);
    assert.deepEqual(result.new_fruit_ids, []);
  } finally {
    await game.close();
  }
});
test("kinematic estimates use only visible snapshot values", () => {
  const scene = {
    arena: { width: 1000, height: 800 },
    gravity: 800,
    clock_audit: { observed_at_ms: 1000 },
    objects: [
      {
        id: 1,
        kind: "fruit",
        fruit: "apple",
        x: 100,
        y: 500,
        vx: 0,
        vy: -400,
        radius: 40,
        hit_radius: 40.8,
      },
    ],
  } as Scene;
  const enriched = enrichObservation(scene, 2300);
  assert.equal(enriched.captured_at_ms, 1000);
  assert.equal(enriched.objects[0].motion_phase, "rising");
  assert.equal(enriched.objects[0].time_to_apex_ms, 500);
  assert.equal(enriched.objects[0].time_to_exit_ms, 1549);
  assert.deepEqual(scene.objects[0], {
    id: 1,
    kind: "fruit",
    fruit: "apple",
    x: 100,
    y: 500,
    vx: 0,
    vy: -400,
    radius: 40,
    hit_radius: 40.8,
  });
});
test("fresh MCP start returns a newly visible scene and explicit observation contract", async () => {
  const game = await GameRuntime.launch(),
    server = buildServer(game, "mcp", "fresh"),
    client = new Client({ name: "fresh-contract", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    await game.prepare({ mode: "arcade", seed: 42, duration_seconds: 5 });
    const tools = (await client.listTools()).tools;
    assert.ok(tools.some((t) => t.name === "observe"));
    const result = await client.callTool({ name: "start_game", arguments: {} });
    assert.ok(!result.isError);
    const value = result.structuredContent as any;
    assert.equal(value.trigger, "new_fruit");
    assert.ok(value.scene.objects.length > 0);
    assert.ok(
      value.scene.objects.every((e: any) => Number.isFinite(e.time_to_exit_ms)),
    );
    const waiting = await client.callTool({
      name: "observe",
      arguments: { until: "new_fruit", timeout_ms: 40 },
    });
    assert.equal((waiting.structuredContent as any).trigger, "timeout");
  } finally {
    await client.close();
    await server.close();
    await game.close();
  }
});
