// PUBLIC: shipped to builder and play sandboxes. Must not import private evaluator code.
import { setTimeout as sleep } from "node:timers/promises";

export interface TimedPoint {
  x: number;
  y: number;
  t_ms: number;
}
export interface PointerSample {
  x: number;
  y: number;
  requested_t_ms: number;
  issued_t_ms: number;
  ack_t_ms: number;
}
interface Driver {
  move: (x: number, y: number) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}

/** Shared legal-input limits for every interface (GUI drag, generated-MCP port path). */
export const pathLimits = {
  minimum_points: 2,
  maximum_points: 32,
  minimum_duration_ms: 16,
  maximum_duration_ms: 1000,
  maximum_speed_px_s: 5000,
} as const;

/** Same validation and native mouse executor are used for BOTH interfaces. */
export function validatePath(
  points: TimedPoint[],
  bounds: { width: number; height: number },
): void {
  if (
    !Array.isArray(points) ||
    points.length < pathLimits.minimum_points ||
    points.length > pathLimits.maximum_points
  )
    throw new Error("A drag needs 2..32 timed points");
  for (let i = 0; i < points.length; i++) {
    const p = points[i],
      previous = points[i - 1];
    if (
      !p ||
      typeof p !== "object" ||
      ![p.x, p.y, p.t_ms].every(Number.isFinite) ||
      p.x < 0 ||
      p.y < 0 ||
      p.x > bounds.width ||
      p.y > bounds.height ||
      !Number.isInteger(p.t_ms) ||
      (i === 0 ? p.t_ms !== 0 : p.t_ms <= previous.t_ms)
    )
      throw new Error(
        "Coordinates must be inside bounds; integer t_ms starts at 0 and strictly increases",
      );
    if (
      previous &&
      Math.hypot(p.x - previous.x, p.y - previous.y) /
        ((p.t_ms - previous.t_ms) / 1000) >
        pathLimits.maximum_speed_px_s
    )
      throw new Error("Blade speed exceeds 5000 px/s");
  }
  const duration = points.at(-1)!.t_ms;
  if (
    duration < pathLimits.minimum_duration_ms ||
    duration > pathLimits.maximum_duration_ms
  )
    throw new Error("A drag must last 16..1000 milliseconds");
}

/** Follow actor coordinates on wall time, dropping obsolete INTERIOR samples only. */
export async function executeTimedPath(
  points: TimedPoint[],
  driver: Driver,
): Promise<PointerSample[]> {
  const now = driver.now ?? (() => performance.now()),
    pause = driver.sleep ?? sleep,
    started = now();
  const samples: PointerSample[] = [];
  let previous = points[0],
    lastIssued = started,
    lastLogical = 0;
  for (let segment = 1; segment < points.length; segment++) {
    const a = points[segment - 1],
      b = points[segment];
    while (true) {
      const due = Math.min(b.t_ms, lastLogical + 8),
        delay = started + due - now();
      if (delay > 0) await pause(delay);
      const t = Math.min(b.t_ms, Math.max(a.t_ms, now() - started)),
        alpha = (t - a.t_ms) / (b.t_ms - a.t_ms);
      const x = a.x + (b.x - a.x) * alpha,
        y = a.y + (b.y - a.y) * alpha;
      // Do not exceed the shared speed limit when delayed corners bunch together.
      const speedDelay =
        lastIssued +
        (Math.hypot(x - previous.x, y - previous.y) /
          pathLimits.maximum_speed_px_s) *
          1000 -
        now();
      if (speedDelay > 0) await pause(speedDelay);
      const issued = now();
      await driver.move(x, y);
      samples.push({
        x,
        y,
        requested_t_ms: t,
        issued_t_ms: issued - started,
        ack_t_ms: now() - started,
      });
      previous = { x, y, t_ms: t };
      lastIssued = issued;
      lastLogical = t;
      if (t >= b.t_ms) break; // Every commanded corner is emitted, even if already overdue.
    }
  }
  return samples;
}
