import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GameRuntime } from "../src/runtime.js";
import { buildServer } from "../src/server.js";

const points = [
  { x: 100, y: 600, t_ms: 0 },
  { x: 1100, y: 600, t_ms: 1000 },
];

test("a native input failure after async acceptance releases the blade and action slot", async () => {
  const game = await GameRuntime.launch();
  const move = game.page.mouse.move.bind(game.page.mouse),
    up = game.page.mouse.up.bind(game.page.mouse);
  let moves = 0,
    releases = 0;
  try {
    await game.prepare({ mode: "arcade", seed: 42, duration_seconds: 5 });
    await game.start();
    game.page.mouse.move = async (...args) => {
      if (++moves === 2) throw new Error("Injected native transport failure");
      return move(...args);
    };
    game.page.mouse.up = async (...args) => {
      releases++;
      return up(...args);
    };
    const accepted = await game.submitPath({ points }, "canvas");
    assert.equal(accepted.accepted, true);
    await game.scene();
    assert.equal(game.actionStatus().pending_action, null);
    assert.equal(game.actionStatus().previous_action?.status, "failed");
    assert.match(
      game.actionStatus().previous_action!.error!,
      /Injected native transport failure/,
    );
    assert.equal(releases, 1);
  } finally {
    game.page.mouse.move = move;
    game.page.mouse.up = up;
    await game.close();
  }
});

test("async acknowledgement overlaps a bounded native path and busy requests never queue", async () => {
  const game = await GameRuntime.launch();
  try {
    await game.prepare({ mode: "arcade", seed: 42, duration_seconds: 5 });
    await game.start();
    await assert.rejects(game.submitPath({ points: [points[0]] }, "canvas"));
    assert.equal(game.actionStatus().pending_action, null);
    const began = performance.now();
    const accepted = await game.submitPath({ points }, "canvas");
    assert.ok(performance.now() - began < 450);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.pending_action?.action_id, accepted.action_id);
    const busy = await game.submitPath({ points }, "canvas");
    assert.equal(busy.accepted, false);
    assert.equal(busy.action_id, accepted.action_id);
    await sleep(250);
    const during = await game.peek();
    assert.ok(during.elapsed_ms > accepted.scene.elapsed_ms + 150);
    assert.ok(game.actionStatus().pending_action);
    await sleep(1000);
    const after = await game.peek();
    assert.equal(after.revision, accepted.scene.revision);
    assert.equal(game.actionStatus().pending_action, null);
    const completed = game.actionStatus().previous_action!;
    assert.equal(completed.status, "completed");
    assert.ok(
      completed.actual_duration_ms! >= 1000 &&
        completed.actual_duration_ms! < 1450,
    );
    assert.ok(after.elapsed_ms >= 1200);
  } finally {
    await game.close();
  }
});

test("async GUI receives pixels and generic executor status without structured game state", async () => {
  const game = await GameRuntime.launch(),
    server = buildServer(game, "gui", "async", "compact"),
    client = new Client({ name: "async-gui-contract", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    await game.prepare({ mode: "arcade", seed: 42, duration_seconds: 5 });
    await game.start();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "click",
      "get_controls",
      "get_screenshot",
      "submit_drag",
      "wait",
    ]);
    const result = await client.callTool({
      name: "submit_drag",
      arguments: { points },
    });
    assert.ok(!result.isError);
    assert.ok(
      (result.content as any[]).some(
        (c: any) => c.type === "image" && c.mimeType === "image/png",
      ),
    );
    const status = JSON.parse(
      (result.content as any[]).find((c) => c.type === "text").text,
    );
    assert.deepEqual(Object.keys(status).sort(), [
      "accepted",
      "action_id",
      "pending_action",
      "previous_action",
    ]);
    assert.equal(status.accepted, true);
    assert.ok(!result.structuredContent);
    assert.equal(status.previous_action, null);
    // Closing waits for the existing native path and releases the mouse.
  } finally {
    await client.close();
    await server.close();
    await game.close();
  }
});

test("async failure before acceptance releases the slot and returns a tool error", async () => {
  const game = await GameRuntime.launch(),
    server = buildServer(game, "mcp", "async"),
    client = new Client({ name: "async-failure-contract", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    await game.prepare({ mode: "arcade", seed: 42, duration_seconds: 5 });
    const failed = await client.callTool({
      name: "submit_swipe",
      arguments: { points },
    });
    assert.equal(failed.isError, true);
    assert.equal(game.actionStatus().pending_action, null);
    await game.start();
    const result = await client.callTool({
      name: "submit_swipe",
      arguments: { points },
    });
    assert.ok(!result.isError);
    const value = result.structuredContent as any;
    assert.equal(value.accepted, true);
    assert.equal(value.scene.revision, 2);
    assert.equal(value.previous_action.status, "failed");
  } finally {
    await client.close();
    await server.close();
    await game.close();
  }
});
