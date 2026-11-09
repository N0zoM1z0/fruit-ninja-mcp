import test from "node:test";
import assert from "node:assert/strict";
import { viewerSnapshot } from "../native/viewer.mjs";
import { GameController, createServer } from "../native/cli.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

test("GUI spectator projection excludes recovered entities and planner targets", () => {
  const state = {
    score: 12,
    remaining: 48,
    phase: "playing",
    canvas: { width: 1024, height: 768, W: 480, H: 360 },
    fruits: [{ id: "secret-fruit-pointer" }],
    bombs: [{ id: "secret-bomb-pointer" }],
    observation_ms: 4,
  };
  const data = { state, plan: { targets: ["secret-fruit-pointer"] } };
  const gui = viewerSnapshot("gui", data);
  assert.equal(gui.score, 12);
  assert.equal(gui.observer_only, true);
  for (const key of ["scene", "targets", "observation_ms"])
    assert.equal(key in gui, false);
  assert.equal(JSON.stringify(gui).includes("secret-"), false);
  assert.deepEqual(viewerSnapshot("mcp", data).scene.fruits, state.fruits);
});

test("executor closes input at the result boundary and rejects overlapping strokes", async () => {
  let release, entered;
  const inWorker = new Promise((resolve) => (entered = resolve));
  const worker = new Promise((resolve) => (release = resolve));
  let sent = 0;
  const runtime = {
    helper: {
      request: async () => ({
        alive: true,
        window: { left: 0, top: 0, width: 1024, height: 768 },
      }),
    },
    desktop: {
      request: async () => {
        sent++;
        entered();
        await worker;
        return { ok: true };
      },
    },
  };
  const game = new GameController(runtime);
  const points = [
    { x: 10, y: 20, t_ms: 0 },
    { x: 20, y: 30, t_ms: 100 },
  ];
  const stroke = game.execute(points);
  await inWorker;
  await assert.rejects(game.execute(points), /busy/);
  game.inputClosed = true;
  await assert.rejects(game.execute(points), /ended/);
  release();
  await stroke;
  assert.equal(sent, 1);
});

test("malformed GUI strokes never reach the shared desktop executor", async () => {
  let sent = 0;
  const game = new GameController({
    helper: {
      request: async () => ({
        alive: true,
        window: { left: 0, top: 0, width: 1024, height: 768 },
      }),
    },
    desktop: {
      request: async () => {
        sent++;
      },
    },
  });
  for (const points of [
    [
      { x: 10, y: 20, t_ms: 0 },
      { x: 10, y: 30, t_ms: 0 },
    ],
    [
      { x: 10, y: 20, t_ms: 0 },
      { x: 1024, y: 30, t_ms: 100 },
    ],
    [
      { x: 10, y: 20, t_ms: 0 },
      { x: 1000, y: 30, t_ms: 1 },
    ],
  ])
    await assert.rejects(game.execute(points));
  assert.equal(sent, 0);
  assert.equal(game.executing, false);
});

test("one torn native observation skips an action instead of ending the round", async () => {
  const game = new GameController({ helper: {} });
  game.sliceOnce = async () => {
    throw new Error("Native entity snapshot changed");
  };
  const result = await game.slice();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "state-changing");
});

test("GUI MCP surface returns only game pixels and input timing, without native reads", async () => {
  const ready = GameController.prototype.ready;
  GameController.prototype.ready = async () => {};
  let setup;
  let initialized = false;
  let releaseStart;
  const startGate = new Promise((resolve) => (releaseStart = resolve));
  let enterStart;
  const starting = new Promise((resolve) => (enterStart = resolve));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
    "base64",
  );
  try {
    setup = await createServer(
      {
        helper: {
          request: async (command) => {
            assert.equal(
              command,
              "info",
              "GUI tool must not read native process memory",
            );
            return {
              alive: true,
              window: { left: 0, top: 0, width: 1024, height: 768 },
            };
          },
        },
        desktop: {
          request: async (request) => {
            assert.equal(
              initialized,
              true,
              "first input and screenshot wait for common initialization",
            );
            return request.op === "screenshot"
              ? { ok: true, data: png.toString("base64") }
              : { ok: true, duration_ms: 100 };
          },
        },
      },
      "gui",
      {
        preparedRound: true,
        beforeAction: async () => {
          enterStart();
          await startGate;
          initialized = true;
        },
      },
    );
  } finally {
    GameController.prototype.ready = ready;
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gui-contract", version: "1" });
  try {
    await setup.server.connect(serverSide);
    await client.connect(clientSide);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
      "click",
      "drag",
      "get_controls",
      "get_screenshot",
    ]);
    const pending = client.callTool({
      name: "drag",
      arguments: {
        points: [
          { x: 100, y: 100, t_ms: 0 },
          { x: 200, y: 200, t_ms: 100 },
        ],
      },
    });
    await starting;
    assert.equal(initialized, false);
    releaseStart();
    const result = await pending;
    assert.deepEqual(
      result.content.map((c) => c.type),
      ["text", "image"],
    );
    assert.deepEqual(JSON.parse(result.content[0].text), {
      ok: true,
      duration_ms: 100,
    });
    assert.equal(result.content[1].data, png.toString("base64"));
    assert.equal(JSON.stringify(result).includes("fruits"), false);
  } finally {
    await client.close();
    await setup.server.close();
  }
});
