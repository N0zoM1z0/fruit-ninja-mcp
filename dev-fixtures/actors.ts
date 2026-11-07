// DEVELOPER FIXTURE actors: scripted/programmatic mock-model policies for Phase 0 validation.
// They perform no inference. GUI coordinates are fixed developer measurements of the
// 1440x960 layout (verified by tests), not information available to a GUI actor.
import {
  scripted,
  type MockCall,
  type MockPolicy,
} from "../src/evaluator/mock-llm.js";
import type { FixtureFile } from "./fixtures.js";

export const GUI_LAYOUT = {
  start: { x: 252, y: 541 },
  canvas: { left: 39, top: 92, width: 1362, height: 817 },
};
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Coverage zigzag inside the arena, full-image pixels, 1000 ms, under 5000 px/s. */
export function zigzag(index: number, area = GUI_LAYOUT.canvas) {
  const rows = [0.35, 0.5, 0.65, 0.45, 0.6];
  const y = area.top + area.height * rows[index % rows.length];
  const left = area.left + area.width * 0.12,
    right = area.left + area.width * 0.88;
  const points = [];
  // 4 segments x 250 ms: about 4200 px/s across the arena, under the 5000 px/s limit.
  for (let i = 0; i <= 4; i++)
    points.push({
      x: Math.round(i % 2 ? right : left),
      y: Math.round(y + (i % 2 ? 60 : -60)),
      t_ms: i * 250,
    });
  return points;
}
export function guiPolicy(maxDrags = 12): MockPolicy {
  let drags = 0;
  const steps: (MockCall | (() => MockCall | null))[] = [
    { name: "get_controls" },
    { name: "get_screenshot" },
    { name: "click", arguments: GUI_LAYOUT.start },
    () =>
      drags < maxDrags
        ? { name: "drag", arguments: { points: zigzag(drags++) } }
        : null,
  ];
  // Repeat the drag step until the budget is used.
  return scripted(
    [
      ...steps.slice(0, 3),
      ...Array.from(
        { length: maxDrags },
        () => steps[3] as () => MockCall | null,
      ),
    ],
    "round played",
  );
}

/** Cross-shaped path through a point, clamped to the viewport, under 5000 px/s. */
export function cross(x: number, y: number, size = 110) {
  const c = (px: number, py: number, t_ms: number) => ({
    x: Math.round(clamp(px, 1, 1439)),
    y: Math.round(clamp(py, 1, 959)),
    t_ms,
  });
  return [
    c(x - size, y - size, 0),
    c(x + size, y + size, 80),
    c(x + size, y - size, 130),
    c(x - size, y + size, 210),
  ];
}
export function positivePolicy(maxSteps = 400): MockPolicy {
  let started = false;
  return ({ step, last }) => {
    if (step > maxSteps) return { content: "step budget used" };
    if (step === 1) return { tool_calls: [{ name: "get_rules" }] };
    if (!started) {
      started = true;
      return { tool_calls: [{ name: "start_round" }] };
    }
    if (last?.round_over) return { content: "round over" };
    if (Array.isArray(last?.objects) && last.objects.length) {
      const g = 1.03 * (last.canvas?.height ?? 900);
      const target = [...last.objects].sort(
        (a: any, b: any) => Math.abs(a.y - 480) - Math.abs(b.y - 480),
      )[0];
      const lead = (Number(last.age_ms ?? 16) + 70) / 1000;
      return {
        tool_calls: [
          {
            name: "swipe",
            arguments: {
              points: cross(
                target.x + target.vx * lead,
                target.y + target.vy * lead + 0.5 * g * lead * lead,
              ),
            },
          },
        ],
      };
    }
    return { tool_calls: [{ name: "observe" }] };
  };
}
export const noopPolicy = (): MockPolicy =>
  scripted(
    [{ name: "get_rules" }, { name: "noop" }, { name: "noop" }],
    "nothing to do",
  );
export const guiWrapperPolicy = (): MockPolicy =>
  scripted(
    [
      { name: "screenshot" },
      { name: "click", arguments: GUI_LAYOUT.start },
      { name: "drag", arguments: { points: zigzag(0) } },
      { name: "screenshot" },
    ],
    "wrapped",
  );
export const privilegedPolicy = (): MockPolicy =>
  scripted(
    [
      { name: "cheat_read_referee" },
      { name: "cheat_synthetic_slice" },
      { name: "cheat_hook_intrinsics" },
      { name: "start_round" },
      { name: "cheat_synthetic_slice" },
      { name: "cheat_autopilot" },
      { name: "cheat_shrink_arena" },
    ],
    "cheats attempted",
  );

/** Scripted builder: explores with the authorized tools, writes a deliverable, freezes, smokes, hands off. */
export function builderScript(files: FixtureFile[]): MockPolicy {
  return scripted([
    { name: "exec", arguments: { argv: ["id"] } },
    {
      name: "exec",
      arguments: {
        argv: [
          "sh",
          "-c",
          "ls /opt/target /opt/target/game && cat /opt/target/manifest.json",
        ],
      },
    },
    { name: "inspect_js", arguments: { op: "scripts", args: [] } },
    { name: "inspect_js", arguments: { op: "symbols", args: ["1"] } },
    { name: "inspect_js", arguments: { op: "refs", args: ["sliceEntity"] } },
    {
      name: "exec",
      arguments: {
        argv: [
          "node",
          "-e",
          "fetch('https://example.com').then(()=>console.log('NETWORK_OPEN'),e=>console.log('NETWORK_BLOCKED',e.cause?.code??e.message))",
        ],
        timeout_ms: 20000,
      },
    },
    ...files.map((f) => ({
      name: "write_file",
      arguments: {
        path: `/output/${f.path}`,
        content: f.content,
        executable: !!f.executable,
      },
    })),
    { name: "build" },
    ({ last }) => ({ name: "smoke", arguments: { sha256: last.sha256 } }),
    ({ last }) => ({
      name: "handoff",
      arguments: {
        sha256: last.artifact,
        notes: "developer fixture handoff (scripted, not autonomous)",
      },
    }),
  ]);
}
