import test from "node:test";
import assert from "node:assert/strict";
import { planComboStroke } from "../native/combo-planner.mjs";
import { planStroke } from "../native/planner.mjs";
import { NativeState, layout } from "../native/state.mjs";

const fruit = (id, x, y, r = 35) => ({ id, x, y, r, vx: 0, vy: 0 });
const scene = () => ({
  phase: "playing",
  now: 0,
  gravity: 0,
  canvas: { left: 0, top: 0, width: 800, height: 600, W: 800, H: 600 },
  fruits: [
    fruit("left", 350, 400),
    fruit("right", 410, 400),
    fruit("middle", 380, 420),
  ],
  bombs: [],
});
const options = {
  lead_ms: 0,
  speed: 4200,
  step_ms: 35,
  max_duration_ms: 450,
  bomb_margin: 10,
};

test("cluster sweep starts outside every fruit and crosses three targets faster than a zigzag", () => {
  const state = scene(),
    plan = planComboStroke(state, options),
    old = planStroke(state, options);
  assert.equal(plan.strategy, "combo-sweep");
  assert.equal(plan.predicted_hits, 3);
  assert.ok(plan.duration_ms < old.duration_ms + 90);
  assert.equal(plan.points.length, 4);
  assert.equal(plan.points[1].t_ms, 45);
  assert.equal(plan.points.at(-1).t_ms - plan.points.at(-2).t_ms, 45);
  for (const f of state.fruits)
    assert.ok(Math.hypot(plan.points[0].x - f.x, plan.points[0].y - f.y) > f.r);
});

test("cluster optimization cannot count fruit hidden inside a bomb collider", () => {
  const state = scene();
  state.bombs = [fruit("bomb", 380, 420, 100)];
  assert.equal(planComboStroke(state, options).ok, false);
  state.bombs[0].age_ms = 500;
  assert.equal(planComboStroke(state, options).reason, "stale-state");
});

test("cuts the safe outer part of a large fruit surrounding a smaller bomb", () => {
  const state = scene();
  state.fruits = [fruit("fruit", 400, 300, 45)];
  state.bombs = [fruit("bomb", 400, 300, 15)];
  const plan = planComboStroke(state, options);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.targets, ["fruit"]);
  for (const p of plan.points) assert.ok(Math.abs(p.y - 300) > 25);
});

test("harvests a visible sphere edge while keeping the whole mouse path inside the window", () => {
  const state = scene();
  state.fruits = [fruit("edge", 810, 300, 30)];
  const plan = planComboStroke(state, options);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.targets, ["edge"]);
  assert.ok(
    plan.points.every((p) => p.x >= 1 && p.x <= 799 && p.y >= 1 && p.y <= 599),
  );
});

function liveListHelper(alwaysTorn = false) {
  let nodes = 0;
  const u32 = (value) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value);
    return b;
  };
  const helper = {
    request: async (command) => {
      if (command === "info")
        return {
          alive: true,
          window: { left: 0, top: 0, width: 1024, height: 768 },
        };
      const [, address, length] = command.split(" ").map(Number);
      let b = Buffer.alloc(length);
      switch (address) {
        case 0x5b3070:
          b.writeInt32LE(2, 4);
          b.writeUInt32LE(0x50000, 0x50);
          break;
        case 0x5b3210:
          b = u32(100);
          break;
        case 0x50104:
          b.writeFloatLE(60);
          break;
        case 0x5c0b00:
          b = u32(0x10000);
          break;
        case 0x10000:
          b.writeUInt32LE(0x20000);
          b.writeUInt32LE(0x30000, 12);
          b.writeUInt32LE(1, 16);
          break;
        case 0x20000:
          b = u32(0x20000);
          break;
        case 0x30000:
          b = u32(0x31000);
          break;
        case 0x31000:
          b.writeUInt32LE(0x30000);
          b.writeUInt32LE(alwaysTorn || nodes++ === 0 ? 0 : 0x32000, 8);
          break;
        case 0x32000:
          b.writeUInt32LE(Number(layout.bomb.vtable_address));
          b.writeUInt32LE(0x33000, layout.common.collider_pointer_offset);
          b.writeFloatLE(1, layout.bomb.time_scale_f32_offset);
          break;
        case 0x33014:
          b.writeFloatLE(20);
          break;
        default:
          throw new Error(`Unexpected native read ${address.toString(16)}`);
      }
      return { ok: true, hex: b.toString("hex") };
    },
  };
  return helper;
}

test("live list mutation retries the entire snapshot without silently dropping a bomb", async () => {
  const state = await new NativeState(liveListHelper()).observe();
  assert.equal(state.bombs.length, 1);
  assert.ok(state.warnings.includes("snapshot-retried"));
  await assert.rejects(
    new NativeState(liveListHelper(true)).observe(),
    /snapshot changed/,
  );
});
