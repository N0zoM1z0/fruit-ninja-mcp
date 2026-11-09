import test from "node:test";
import assert from "node:assert/strict";
import { screen, world, planStroke } from "../native/planner.mjs";
import { planComboStroke } from "../native/combo-planner.mjs";

test("camera input transform round-trips zoom, rotation and offset", () => {
  const canvas = {
    left: 0,
    top: 0,
    width: 1024,
    height: 768,
    W: 480,
    H: 360,
    camera: { active: true, zoom: 2, angle: Math.PI / 5, x: 20, y: -15 },
  };
  const p = { x: 600, y: 100 };
  const q = world(screen(p, canvas), canvas);
  assert.ok(Math.hypot(p.x - q.x, p.y - q.y) < 1e-9);
  canvas.camera.angle = 0;
  const state = {
    phase: "playing",
    now: 0,
    gravity: 0,
    canvas,
    fruits: [
      {
        id: "visible-outside-old-viewport",
        x: 600,
        y: 180,
        r: 35,
        vx: 0,
        vy: 0,
      },
    ],
    bombs: [],
  };
  assert.equal(planStroke(state).ok, true);
  const plan = planComboStroke(state, { max_duration_ms: 450 });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.targets, ["visible-outside-old-viewport"]);
  for (const point of plan.points)
    assert.ok(point.x > 0 && point.x < 1024 && point.y > 0 && point.y < 768);
});
