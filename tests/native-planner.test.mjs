import test from "node:test";
import assert from "node:assert/strict";
import { planStroke } from "../native/planner.mjs";

const entity = (id, x, y, rest = {}) => ({
  id,
  x,
  y,
  r: 20,
  vx: 0,
  vy: 0,
  age_ms: 0,
  ...rest,
});
const scene = (rest = {}) => ({
  phase: "playing",
  now: 1000,
  gravity: 0,
  canvas: { left: 0, top: 0, width: 800, height: 600, W: 800, H: 600 },
  fruits: [],
  bombs: [],
  ...rest,
});

test("intercepts moving fruit using native latency, sample age and measured gravity", () => {
  const state = scene({
    gravity: 600,
    fruits: [entity("a", 300, 300, { vx: 100, vy: -200, age_ms: 20 })],
  });
  const plan = planStroke(state, { now_ms: 1010, lead_ms: 50 });
  assert.equal(plan.ok, true);
  assert.equal(plan.start_at_ms, 1060);
  const hit = plan.points[1],
    dt = 0.08 + hit.t_ms / 1000;
  assert.ok(Math.abs(hit.x - (300 + 100 * dt)) < 1e-9);
  assert.ok(Math.abs(hit.y - (300 - 200 * dt + 300 * dt ** 2)) < 1e-9);
  assert.ok(
    Math.hypot(
      plan.points[0].x - 308,
      plan.points[0].y - (300 - 200 * 0.08 + 300 * 0.08 ** 2),
    ) > 20,
  );
  assert.deepEqual(plan.targets, ["a"]);
});

test("greedy chain predicts later interception, and respects native pixel speed after scaling", () => {
  const state = scene({
    canvas: { left: 100, top: 70, width: 1600, height: 900, W: 800, H: 600 },
    fruits: [
      entity("a", 400, 500),
      entity("b", 500, 400, { vx: 100, vy: -20 }),
    ],
  });
  const plan = planStroke(state, { lead_ms: 0, speed: 1000 });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.targets, ["a", "b"]);
  assert.deepEqual(plan.points[1], { x: 900, y: 820, t_ms: 56 });
  assert.ok(plan.points[2].x > 1100);
  const p = plan.points;
  assert.ok(
    Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) / (p[1].t_ms / 1000) <=
      1000 + 1e-6,
  );
});

test("does not begin a stroke on fruit overlapping a bomb", () => {
  const plan = planStroke(
    scene({ fruits: [entity("a", 400, 300)], bombs: [entity("b", 400, 300)] }),
  );
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "no-safe-chain");
});

test("single-target stroke enters from outside the sphere and avoids the adjacent bomb", () => {
  const plan = planStroke(
    scene({
      fruits: [entity("a", 400, 300)],
      bombs: [entity("b", 445, 300, { r: 10 })],
    }),
    { lead_ms: 0, bomb_margin: 5 },
  );
  assert.equal(plan.ok, true);
  assert.ok(plan.points[0].x < 380);
  assert.equal(plan.points[1].x, 400);
});

test("fast bomb crossing between endpoints prevents an otherwise attractive chain", () => {
  const plan = planStroke(
    scene({
      fruits: [entity("a", 400, 500), entity("b", 600, 500)],
      bombs: [entity("bomb", 500, 360, { vy: 1000, r: 8 })],
    }),
    { lead_ms: 0, speed: 1000, bomb_margin: 0 },
  );
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.targets, ["a"]);
});

test("no implicit browser gravity and no stale or malformed bomb observations", () => {
  assert.equal(
    planStroke(scene({ gravity: undefined })).reason,
    "missing-gravity",
  );
  assert.equal(
    planStroke(scene({ bombs: [entity("b", 1, 1, { age_ms: 500 })] })).reason,
    "stale-state",
  );
  assert.equal(
    planStroke(scene({ bombs: [entity("b", 1, 1, { vx: NaN })] })).reason,
    "invalid-entities",
  );
});

test("does not clamp an offscreen intercept into a false hit", () => {
  const plan = planStroke(
    scene({ fruits: [entity("a", 799, 300, { vx: 100 })] }),
    { lead_ms: 45 },
  );
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "no-fruits");
});
