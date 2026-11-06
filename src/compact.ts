import type { Scene } from "./types.js";

/** Reduce model payload; complete precision and clock audits remain in artifacts. */
export function compactObservation(scene: Scene) {
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    phase: scene.phase,
    revision: scene.revision,
    elapsed_ms: scene.elapsed_ms,
    remaining_ms: scene.remaining_ms,
    captured_at_ms: scene.clock_audit.observed_at_ms,
    arena: scene.arena,
    gravity: scene.gravity,
    stats: scene.stats,
    objects: scene.objects.map((object) => {
      const { fruit: _, ...rest } = object;
      void _;
      return {
        ...rest,
        x: round(object.x),
        y: round(object.y),
        vx: round(object.vx),
        vy: round(object.vy),
        radius: round(object.radius),
        hit_radius: round(object.hit_radius),
      };
    }),
  };
}
