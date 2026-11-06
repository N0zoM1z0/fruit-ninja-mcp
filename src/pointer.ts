import { setTimeout as sleep } from "node:timers/promises";
import type { TimedPoint } from "./types.js";

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
        (Math.hypot(x - previous.x, y - previous.y) / 5000) * 1000 -
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
