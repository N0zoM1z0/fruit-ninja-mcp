import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GameRuntime, validatePath } from "../src/runtime.js";
import { buildServer } from "../src/server.js";
import { hostGame } from "../src/host.js";
import { executeTimedPath } from "../src/pointer.js";

async function game() {
  const runtime = await GameRuntime.launch();
  await runtime.prepare({ mode: "arcade", seed: 42, duration_seconds: 5 });
  return runtime;
}
test("bounded paths reject invalid input without any execution", () => {
  const bounds = { width: 1000, height: 800 };
  validatePath(
    [
      { x: 10, y: 10, t_ms: 0 },
      { x: 110, y: 10, t_ms: 100 },
    ],
    bounds,
  );
  assert.throws(() =>
    validatePath(
      [
        { x: 10, y: 10, t_ms: 0 },
        { x: 1001, y: 10, t_ms: 100 },
      ],
      bounds,
    ),
  );
  assert.throws(() =>
    validatePath(
      [
        { x: 10, y: 10, t_ms: 0 },
        { x: 800, y: 10, t_ms: 20 },
      ],
      bounds,
    ),
  );
  assert.throws(() =>
    validatePath(
      [
        { x: 10, y: 10, t_ms: 0 },
        { x: 20, y: 10, t_ms: 0 },
      ],
      bounds,
    ),
  );
});

test("slow native acknowledgements do not replay obsolete samples or skip corners", async () => {
  let wall = 0;
  const points = [
    { x: 100, y: 100, t_ms: 0 },
    { x: 400, y: 100, t_ms: 100 },
    { x: 400, y: 300, t_ms: 180 },
  ];
  const samples = await executeTimedPath(points, {
    now: () => wall,
    sleep: async (ms) => {
      wall += ms;
    },
    move: async () => {
      wall += 25;
    },
  });
  assert.ok(wall >= 180 && wall < 300, `180ms path took ${wall}ms`);
  for (const corner of points.slice(1))
    assert.ok(samples.some((p) => p.x === corner.x && p.y === corner.y));
  for (const p of samples) assert.ok(p.issued_t_ms >= p.requested_t_ms);
});
test("the world runs while the actor is idle, observing, blurred or trying to pause", async () => {
  const g = await game();
  try {
    await g.start();
    const began = performance.now();
    await sleep(650);
    let s = await g.scene();
    assert.equal(s.clock, "realtime");
    assert.ok(Math.abs(s.elapsed_ms - (performance.now() - began)) < 100);
    assert.ok(s.objects.length > 0);
    for (const e of s.objects) {
      assert.ok(e.y + e.radius > 0 && e.y - e.radius < s.arena.height);
      assert.equal("seed" in e, false);
    }
    const before = s.elapsed_ms;
    await g.page.keyboard.press("Space");
    await g.page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await g.page.evaluate(() => document.getElementById("pause-home")!.click());
    await g.screenshot();
    await sleep(200);
    s = await g.scene();
    assert.equal(s.phase, "playing");
    assert.ok(s.elapsed_ms > before + 170);
    await assert.rejects(g.start(), /ROUND_ALREADY_STARTED/);
  } finally {
    await g.close();
  }
});
test("native timed mouse input cuts real moving fruit and consumes wall time", async () => {
  const g = await game();
  try {
    await g.start();
    await sleep(600);
    const s = await g.scene(),
      f = s.objects[0];
    assert.ok(f);
    const t = 0.05,
      x = f.x + f.vx * t,
      y = f.y + f.vy * t + 0.5 * s.gravity * t * t;
    const began = performance.now();
    const result = await g.swipe({
      observed_at_ms: s.clock_audit.observed_at_ms,
      points: [
        { x: x - 100, y, t_ms: 0 },
        { x: x + 100, y, t_ms: 100 },
      ],
    });
    assert.ok(performance.now() - began >= 90);
    assert.ok(result.scene.stats.sliced >= 1);
    assert.ok(
      result.events.some(
        (e) => e.type === "fruit_sliced" && e.object_id === f.id,
      ),
    );
    assert.ok(result.actual_duration_ms >= 90);
    assert.ok(
      result.actual_duration_ms < 350,
      `100ms native path took ${result.actual_duration_ms}ms`,
    );
  } finally {
    await g.close();
  }
});
test("a round ends on its own wall-clock deadline without tool calls", async () => {
  const g = await game();
  try {
    await g.start();
    await sleep(5250);
    const s = await g.scene();
    assert.equal(s.phase, "finished");
    assert.equal(s.elapsed_ms, 5000);
    assert.ok(
      s.clock_audit.finished_wall_elapsed_ms! >= 5000 &&
        s.clock_audit.finished_wall_elapsed_ms! < 5300,
    );
    assert.ok(s.stats.escaped_fruit > 0);
    assert.equal(s.stats.score, 0);
    assert.equal(
      (await g.events()).events.filter((e) => e.type === "round_finished")
        .length,
      1,
    );
  } finally {
    await g.close();
  }
});
test("GUI tools return images only and expose no application state or start shortcut", async () => {
  const g = await game(),
    server = buildServer(g, "gui"),
    client = new Client({ name: "gui-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(
      names,
      ["click", "drag", "get_controls", "get_screenshot", "wait"].sort(),
    );
    const result = await client.callTool({
      name: "get_screenshot",
      arguments: {},
    });
    assert.equal(result.structuredContent, undefined);
    assert.equal((result.content as any[])[0].type, "image");
    const rect = await g.page.locator("#start-button").boundingBox();
    assert.ok(rect);
    const clicked = await client.callTool({
      name: "click",
      arguments: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    });
    assert.equal(clicked.structuredContent, undefined);
    assert.equal((clicked.content as any[])[0].type, "image");
    assert.equal((await g.scene()).phase, "playing");
  } finally {
    await client.close();
    await server.close();
    await g.close();
  }
});
test("MCP HTTP disconnect does not terminate the independently owned game", async () => {
  const g = await game(),
    host = await hostGame(g, "mcp"),
    client = new Client({ name: "disconnect-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(host.url)));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes("start_game"));
    assert.ok(!tools.includes("new_game"));
    await client.callTool({ name: "start_game", arguments: {} });
    await client.close();
    await sleep(400);
    const s = await g.scene();
    assert.equal(s.phase, "playing");
    assert.ok(s.elapsed_ms >= 380);
  } finally {
    await host.close();
    await g.close();
  }
});
