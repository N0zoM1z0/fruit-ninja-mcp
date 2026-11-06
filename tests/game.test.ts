import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GameRuntime } from "../src/runtime.js";
import { buildServer } from "../src/server.js";
import type { GameObject, Scene } from "../src/types.js";

let game: GameRuntime;
before(async () => {
  game = await GameRuntime.launch();
});
after(async () => {
  await game?.close();
});

async function start(
  mode: "arcade" | "classic" | "zen" = "arcade",
  seed = 42,
): Promise<Scene> {
  return game.newGame({
    mode,
    seed,
    ...(mode !== "classic" ? { duration_seconds: 20 } : {}),
  });
}
async function wait(
  scene: Scene,
  duration_ms: number,
  until_objects = false,
): Promise<Scene> {
  return (
    await game.wait({
      expected_revision: scene.revision,
      duration_ms,
      until_objects,
    })
  ).scene;
}
function predict(scene: Scene, object: GameObject, ms: number) {
  const t = ms / 1000;
  return {
    x: object.x + object.vx * t,
    y: object.y + object.vy * t + 0.5 * scene.gravity * t * t,
  };
}

test("thinking, screenshots and reads do not consume simulation time", async () => {
  const scene = await wait(await start(), 600);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const screenshot = await game.screenshot();
  assert.equal(screenshot.subarray(1, 4).toString(), "PNG");
  await game.events();
  assert.deepEqual(await game.scene(), scene);
});

test("observations contain only visible live objects and public fields", async () => {
  const scene = await wait(await start(), 1000, true);
  assert.ok(scene.elapsed_ms < 1000);
  assert.ok(scene.objects.length > 0);
  for (const e of scene.objects) {
    assert.ok(
      e.x + e.radius > 0 &&
        e.x - e.radius < scene.arena.width &&
        e.y + e.radius > 0 &&
        e.y - e.radius < scene.arena.height,
    );
    assert.deepEqual(
      Object.keys(e).sort(),
      [
        "id",
        "kind",
        "fruit",
        "x",
        "y",
        "vx",
        "vy",
        "radius",
        "hit_radius",
      ].sort(),
    );
  }
  assert.equal("seed" in scene, false);
  assert.equal("spawnIn" in scene, false);
});

test("a timed pointer swipe uses normal collisions and reports the sliced ID", async () => {
  const scene = await wait(await start(), 600),
    fruit = scene.objects[0];
  const p = predict(scene, fruit, 50);
  const result = await game.swipe({
    expected_revision: scene.revision,
    points: [
      { x: p.x - 100, y: p.y, t_ms: 0 },
      { x: p.x + 100, y: p.y, t_ms: 100 },
    ],
  });
  assert.equal(result.scene.stats.sliced, 1);
  assert.equal(result.scene.stats.score, 1);
  assert.equal(result.scene.elapsed_ms, 700);
  assert.ok(
    result.events.some(
      (e) => e.type === "fruit_sliced" && e.object_id === fruit.id,
    ),
  );
  assert.ok(!result.scene.objects.some((e) => e.id === fruit.id));
});

test("stale, out-of-bounds, too-fast and malformed paths are atomic rejections", async () => {
  const scene = await wait(await start(), 600);
  const paths = [
    {
      expected_revision: scene.revision - 1,
      points: [
        { x: 10, y: 10, t_ms: 0 },
        { x: 20, y: 10, t_ms: 100 },
      ],
    },
    {
      expected_revision: scene.revision,
      points: [
        { x: 10, y: 10, t_ms: 0 },
        { x: scene.arena.width + 1, y: 10, t_ms: 100 },
      ],
    },
    {
      expected_revision: scene.revision,
      points: [
        { x: 10, y: 10, t_ms: 0 },
        { x: 1000, y: 10, t_ms: 20 },
      ],
    },
    {
      expected_revision: scene.revision,
      points: [
        { x: 10, y: 10, t_ms: 0 },
        { x: 20, y: 10, t_ms: 0 },
      ],
    },
    {
      expected_revision: scene.revision,
      points: [
        { x: 10, y: 10, t_ms: 0 },
        { x: Number.NaN, y: 10, t_ms: 100 },
      ],
    },
  ];
  for (const path of paths) {
    await assert.rejects(game.swipe(path));
    assert.deepEqual(await game.scene(), scene);
    assert.equal((await game.events()).last_seq, 0);
  }
});

test("fruit move during a slow stroke; endpoints do not instantly cut the old scene", async () => {
  const scene = await wait(await start(), 300),
    fruit = scene.objects[0];
  const result = await game.swipe({
    expected_revision: scene.revision,
    points: [
      { x: fruit.x - 100, y: fruit.y, t_ms: 0 },
      { x: fruit.x + 100, y: fruit.y, t_ms: 1000 },
    ],
  });
  assert.equal(result.advanced_ms, 1000);
  assert.ok(
    !result.events.some(
      (e) => e.type === "fruit_sliced" && e.object_id === fruit.id,
    ),
  );
});

test("a continuous curved stroke can earn the game's real multi-fruit combo", async () => {
  const scene = await wait(await start(), 1100),
    fruits = scene.objects
      .filter((e) => e.kind === "fruit")
      .sort((a, b) => a.x - b.x);
  assert.equal(fruits.length, 3);
  const centers = fruits.map((e, i) => ({
    ...predict(scene, e, 60 + i * 80),
    t_ms: 60 + i * 80,
  }));
  const points = [
    { x: centers[0].x - 70, y: centers[0].y, t_ms: 0 },
    ...centers,
    { x: centers[2].x + 70, y: centers[2].y, t_ms: 280 },
  ];
  const result = await game.swipe({
    expected_revision: scene.revision,
    points,
  });
  assert.equal(result.scene.stats.sliced, 3);
  assert.equal(result.scene.stats.max_combo, 3);
  assert.equal(result.scene.stats.score, 6);
});

test("classic ends after three escapes and cannot be advanced after the result", async () => {
  let scene = await start("classic");
  for (let i = 0; i < 5 && scene.phase === "playing"; i++)
    scene = await wait(scene, 3000);
  assert.equal(scene.phase, "finished");
  assert.equal(scene.stats.missed, 3);
  assert.equal(scene.stats.escaped_fruit, 3);
  assert.equal(
    (await game.events()).events.filter((e) => e.type === "round_finished")
      .length,
    1,
  );
  await assert.rejects(
    game.wait({
      expected_revision: scene.revision,
      duration_ms: 100,
      until_objects: false,
    }),
    /ROUND_NOT_PLAYING/,
  );
  assert.deepEqual(await game.scene(), scene);
});

test("seeded waves do not change when earlier strokes consume cosmetic randomness", async () => {
  const control = await wait(await start(), 2300);
  let scene = await wait(await start(), 600),
    fruit = scene.objects[0],
    p = predict(scene, fruit, 50);
  scene = (
    await game.swipe({
      expected_revision: scene.revision,
      points: [
        { x: p.x - 100, y: p.y, t_ms: 0 },
        { x: p.x + 100, y: p.y, t_ms: 100 },
      ],
    })
  ).scene;
  scene = await wait(scene, 1600);
  const later = (s: Scene) => s.objects.filter((e) => e.id > 3);
  assert.ok(later(control).length > 0);
  assert.deepEqual(later(scene), later(control));
});

test("a real bomb is hittable and produces the arcade penalty event", async () => {
  let scene = await start(),
    bomb: GameObject | undefined;
  for (let i = 0; i < 70; i++) {
    scene = await wait(scene, 250);
    bomb = scene.objects.find(
      (e) =>
        e.kind === "bomb" &&
        Math.abs(e.vy) < 250 &&
        e.y > e.radius &&
        e.y < scene.arena.height - e.radius,
    );
    if (bomb) break;
  }
  assert.ok(bomb, "seed 42 should produce a visible bomb");
  const p = predict(scene, bomb, 40);
  const result = await game.swipe({
    expected_revision: scene.revision,
    points: [
      { x: Math.max(0, p.x - 60), y: p.y, t_ms: 0 },
      { x: Math.min(scene.arena.width, p.x + 60), y: p.y, t_ms: 80 },
    ],
  });
  assert.equal(result.scene.stats.bombs_hit, 1);
  assert.ok(
    result.events.some((e) => e.type === "bomb_hit" && e.object_id === bomb.id),
  );
});

test("the round timer ends once and shows the real result dialog", async () => {
  let scene = await game.newGame({
    mode: "arcade",
    seed: 42,
    duration_seconds: 20,
  });
  while (scene.phase === "playing") scene = await wait(scene, 3000);
  assert.equal(scene.phase, "finished");
  assert.equal(scene.elapsed_ms, 20000);
  assert.equal(scene.tick, 2400);
  assert.equal(scene.remaining_ms, 0);
  assert.equal(
    (await game.events()).events.filter((e) => e.type === "round_finished")
      .length,
    1,
  );
  assert.equal(
    await game.page
      .locator("#result-dialog")
      .evaluate((el: HTMLDialogElement) => el.open),
    true,
  );
});

test("a classic bomb hit ends immediately with a result and one terminal event", async () => {
  let scene = await start("classic");
  for (let i = 0; i < 240 && scene.phase === "playing"; i++) {
    const bomb = scene.objects.find(
      (e) =>
        e.kind === "bomb" &&
        e.y > e.radius + 50 &&
        e.y < scene.arena.height - e.radius,
    );
    const fruit = scene.objects.find(
      (e) =>
        e.kind === "fruit" &&
        e.y > e.radius + 50 &&
        e.y < scene.arena.height - e.radius,
    );
    const target = bomb ?? fruit;
    if (target) {
      const p = predict(scene, target, 30);
      scene = (
        await game.swipe({
          expected_revision: scene.revision,
          points: [
            { x: Math.max(0, p.x - 70), y: p.y, t_ms: 0 },
            { x: Math.min(scene.arena.width, p.x + 70), y: p.y, t_ms: 60 },
          ],
        })
      ).scene;
    } else scene = await wait(scene, 100);
  }
  assert.equal(scene.stats.bombs_hit, 1);
  assert.equal(scene.phase, "finished");
  assert.ok(scene.stats.missed < 3);
  const events = (await game.events(0, 200)).events;
  assert.equal(events.filter((e) => e.type === "round_finished").length, 1);
  assert.equal(events.at(-2)?.type, "bomb_hit");
  assert.equal(events.at(-1)?.type, "round_finished");
  assert.equal(
    await game.page
      .locator("#result-dialog")
      .evaluate((el: HTMLDialogElement) => el.open),
    true,
  );
});

test("MCP discovery is typed, unknown inputs are rejected, locked sessions cannot reset", async () => {
  const scene = await start();
  const server = buildServer(game, true),
    client = new Client({ name: "contract-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools;
    assert.ok(!tools.some((t) => t.name === "new_game"));
    assert.ok(
      tools.find((t) => t.name === "get_scene")?.annotations?.readOnlyHint,
    );
    assert.ok(!tools.some((t) => /script|evaluate|auto|target/.test(t.name)));
    const result = await client.callTool({
      name: "wait",
      arguments: {
        expected_revision: scene.revision,
        duration_ms: 100,
        unknown: true,
      },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(await game.scene(), scene);
  } finally {
    await client.close();
    await server.close();
  }
});
