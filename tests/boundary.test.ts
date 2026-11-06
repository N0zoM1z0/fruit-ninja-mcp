import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { GameRuntime } from "../src/runtime.js";
import { loadGame, packagedGame, root } from "../src/upstream.js";
import { privateMarkers, refereedGame } from "../src/evaluator/referee.js";
import { GUI_LAYOUT } from "../dev-fixtures/actors.js";
import type { Scene } from "../src/types.js";

async function game() {
  const runtime = await GameRuntime.launch();
  await runtime.prepare({ mode: "arcade", seed: 42, duration_seconds: 8 });
  return runtime;
}
async function visibleFruit(g: GameRuntime, minimumY = 200): Promise<Scene> {
  for (let i = 0; i < 60; i++) {
    const s = await g.scene();
    if (
      s.objects.some(
        (o) =>
          o.kind === "fruit" && o.y > minimumY && o.y < s.arena.height - 120,
      )
    )
      return s;
    await sleep(50);
  }
  throw new Error("no fruit became visible");
}
/** Test oracle only: page coordinates of a path through a fruit predicted from referee state. */
async function pathThrough(g: GameRuntime, s: Scene) {
  const rect = (await g.page.locator("#game").boundingBox())!;
  const f = s.objects.find((o) => o.kind === "fruit" && o.y > 200)!;
  const t = 0.08,
    x = f.x + f.vx * t,
    y = f.y + f.vy * t + 0.5 * s.gravity * t * t;
  const px = rect.x + (x * rect.width) / s.arena.width,
    py = rect.y + (y * rect.height) / s.arena.height;
  return {
    fruit: f,
    page: { x: px, y: py },
    points: [
      { x: px - 150, y: py, t_ms: 0 },
      { x: px + 150, y: py, t_ms: 100 },
    ],
  };
}

test("packaged game carries only public rules; the refereed build adds private hooks", async () => {
  const original = await loadGame();
  const packaged = packagedGame(original);
  const { html, key } = refereedGame(original);
  assert.ok(
    packaged.includes("Content-Security-Policy") &&
      packaged.includes("e.isTrusted !== true") &&
      packaged.includes("__fnPrepare"),
  );
  for (const marker of privateMarkers)
    assert.ok(!packaged.includes(marker), `packaged game contains ${marker}`);
  assert.ok(html.includes(key) && html.includes("reefApi"));
  assert.notEqual(
    refereedGame(original).key,
    key,
    "referee keys are per session",
  );
});

test("hardened page exposes no referee, host hooks, source, string compilation or replaceable built-ins", async () => {
  const g = await game();
  try {
    const page = await g.page.evaluate(() => {
      // CSP: strings are never compiled in page contexts such as timers.
      setTimeout("document.body.dataset.fnLeak = '1'", 0);
      return {
        globals: Object.getOwnPropertyNames(window).filter((n) =>
          /__fn|referee|fruitninja|reef/i.test(n),
        ),
        scripts: document.scripts.length,
        frozen: [
          Object.prototype,
          Function.prototype,
          Array.prototype,
          PointerEvent.prototype,
          MouseEvent.prototype,
          Element.prototype,
          EventTarget.prototype,
          Math,
          JSON,
        ].every(Object.isFrozen),
        rafLocked: !Object.getOwnPropertyDescriptor(
          window,
          "requestAnimationFrame",
        )!.writable,
        canvasHookable: !Object.isFrozen(CanvasRenderingContext2D.prototype),
      };
    });
    assert.deepEqual(page, {
      globals: [],
      scripts: 0,
      frozen: true,
      rafLocked: true,
      canvasHookable: true,
    });
    await sleep(100);
    assert.equal(
      await g.page.evaluate(() => document.body.dataset.fnLeak ?? null),
      null,
      "string timer must not compile",
    );
    const integrity = await g.integrity();
    assert.equal(integrity.lockdown, true);
    assert.deepEqual(integrity.violations, []);
  } finally {
    await g.close();
  }
});

test("dispatched DOM events cannot start or slice; native input can, and slices are attributed", async () => {
  const g = await game();
  try {
    await g.page.evaluate(() =>
      document.getElementById("start-button")!.click(),
    );
    assert.equal(
      (await g.scene()).phase,
      "ready",
      "a synthetic click must not start the round",
    );
    await assert.rejects(
      g.portPath([
        { x: 100, y: 500, t_ms: 0 },
        { x: 300, y: 500, t_ms: 100 },
      ]),
      (error: Error) => error.message === "ROUND_NOT_PLAYING",
      "referee errors surface as one-line codes without source or stack",
    );
    const start = (await g.page.locator("#start-button").boundingBox())!;
    await g.click(start.x + start.width / 2, start.y + start.height / 2);
    assert.equal((await g.scene()).phase, "playing");
    const s = await visibleFruit(g);
    const target = await pathThrough(g, s);
    await g.page.evaluate(({ x, y }) => {
      const canvas = document.getElementById("game")!;
      for (const [type, dx] of [
        ["pointerdown", -150],
        ["pointermove", -50],
        ["pointermove", 50],
        ["pointermove", 150],
        ["pointerup", 150],
      ] as const)
        canvas.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            button: 0,
            buttons: 1,
            pointerId: 3,
            clientX: x + dx,
            clientY: y,
          }),
        );
    }, target.page);
    assert.equal(
      (await g.scene()).stats.sliced,
      0,
      "synthetic pointer events must not slice",
    );
    const fresh = await pathThrough(g, await visibleFruit(g));
    const result = await g.portPath(fresh.points);
    assert.ok(
      result.scene.stats.sliced >= 1,
      "a native path through a visible fruit slices it",
    );
    const integrity = await g.integrity();
    assert.equal(integrity.unattributed_slices, 0);
    assert.ok(
      (await g.events()).events
        .filter((e) => e.type === "fruit_sliced")
        .every((e: any) => e.attributed),
    );
  } finally {
    await g.close();
  }
});

test("an adapter runs after hardening: hidden-state and hooking attempts fail, geometry tampering is detected", async () => {
  const g = await game();
  try {
    const exports = await g.injectAdapter(
      await readFile(
        resolve(root, "dev-fixtures/mcp/adapter-cheats.js"),
        "utf8",
      ),
    );
    assert.ok(exports.includes("read_referee"));
    const found = (await g.adapterCall("read_referee", null)) as any;
    assert.deepEqual(found, {
      suspicious_globals: [],
      fruitNinjaMcp: "undefined",
      fruitNinjaSnapshot: "undefined",
      scripts: 0,
      page_mentions_reef: false,
    });
    const hooks = (await g.adapterCall("hook_intrinsics", null)) as Record<
      string,
      string
    >;
    for (const [name, outcome] of Object.entries(hooks))
      assert.match(outcome, /^blocked/, `${name}: ${outcome}`);
    await g.adapterCall("synthetic_slice", null);
    assert.equal(
      (await g.scene()).phase,
      "ready",
      "adapter cannot start the round with DOM events",
    );
    const start = (await g.adapterCall("locate_start", null)) as {
      x: number;
      y: number;
    };
    await g.click(start.x, start.y);
    await visibleFruit(g);
    await g.adapterCall("synthetic_slice", null);
    assert.equal(
      (await g.scene()).stats.sliced,
      0,
      "adapter-dispatched events never slice",
    );
    await g.adapterCall("shrink_arena", null);
    await sleep(250);
    const integrity = await g.integrity();
    assert.ok(
      integrity.violations.some((v) => v.kind === "canvas_rect_changed"),
      JSON.stringify(integrity.violations),
    );
    await assert.rejects(
      g.adapterCall("not_exported", null),
      /ADAPTER_MISSING/,
    );
  } finally {
    await g.close();
  }
});

test("developer mock GUI coordinates match the real 1440x960 layout", async () => {
  const g = await game();
  try {
    const start = (await g.page.locator("#start-button").boundingBox())!,
      canvas = (await g.page.locator("#game").boundingBox())!;
    assert.ok(
      Math.abs(start.x + start.width / 2 - GUI_LAYOUT.start.x) < 4 &&
        Math.abs(start.y + start.height / 2 - GUI_LAYOUT.start.y) < 4,
    );
    assert.deepEqual(
      {
        left: canvas.x,
        top: canvas.y,
        width: canvas.width,
        height: canvas.height,
      },
      GUI_LAYOUT.canvas,
    );
  } finally {
    await g.close();
  }
});
