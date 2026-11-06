import type { Scene } from "./types.js";

/** Public motion estimates from the visible snapshot only; no spawn/RNG access. */
export function enrichObservation(
  scene: Scene,
  reactionLatencyMs: number | null,
) {
  return {
    ...scene,
    captured_at_ms: scene.clock_audit.observed_at_ms,
    reaction_latency_estimate_ms: reactionLatencyMs,
    objects: scene.objects.map((object) => {
      const distance = Math.max(
          0,
          scene.arena.height + object.radius - object.y,
        ),
        g = scene.gravity,
        v = object.vy;
      const remaining = ((-v + Math.sqrt(v * v + 2 * g * distance)) / g) * 1000;
      return {
        ...object,
        motion_phase: v < 0 ? "rising" : "falling",
        time_to_apex_ms: v < 0 ? Math.round((-v / g) * 1000) : 0,
        time_to_exit_ms: Math.max(0, Math.round(remaining)),
      };
    }),
  };
}
