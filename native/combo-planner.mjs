/** Compare the original greedy chain with short, bomb-safe cluster sweeps. */
import {
  planStroke,
  position,
  screen,
  world,
  inside,
  distance,
  segmentSafe,
} from "./planner.mjs";

function hitsAlong(path, fruits, elapsed, gravity) {
  const hits = [];
  for (const f of fruits) {
    let outside = false,
      hit = false,
      hitAt = 0;
    for (let k = 1; k < path.length && !hit; k++) {
      const a = path[k - 1],
        b = path[k],
        steps = Math.max(1, Math.ceil((b.t_ms - a.t_ms) / 8));
      for (let i = 0; i < steps; i++) {
        const u = i / steps,
          v = (i + 1) / steps;
        const t0 = a.t_ms + (b.t_ms - a.t_ms) * u,
          t1 = a.t_ms + (b.t_ms - a.t_ms) * v;
        const p = position(f, elapsed + t0, gravity),
          q = position(f, elapsed + t1, gravity);
        const x = a.x + (b.x - a.x) * u - p.x,
          y = a.y + (b.y - a.y) * u - p.y;
        const dx = (b.x - a.x) * (v - u) - (q.x - p.x),
          dy = (b.y - a.y) * (v - u) - (q.y - p.y);
        if (Math.hypot(x, y) > f.r + 2) outside = true;
        const den = dx * dx + dy * dy;
        const w = den ? Math.max(0, Math.min(1, -(x * dx + y * dy) / den)) : 0;
        // Leave a penetration margin for prediction and frame sampling error.
        if (outside && Math.hypot(x + dx * w, y + dy * w) < f.r * 0.82) {
          hit = true;
          hitAt = t0 + (t1 - t0) * w;
          break;
        }
      }
    }
    if (hit) hits.push({ ...f, hit_at_ms: hitAt });
  }
  return hits;
}

export function planComboStroke(state, options = {}) {
  let base = planStroke(state, options);
  if (
    !base.ok &&
    !["no-safe-chain", "no-fruits", "unsafe-final-path"].includes(base.reason)
  )
    return base;
  if (!state.fruits.length) return base;
  const canvas = state.canvas,
    gravity = options.gravity ?? state.gravity;
  const now = options.now_ms ?? state.now,
    lead = Math.max(0, Math.min(400, options.lead_ms ?? 45));
  const elapsed = now - state.now + lead;
  const speed = Math.max(600, Math.min(4800, options.speed ?? 3200));
  const maxDuration = Math.max(
    20,
    Math.min(1000, options.max_duration_ms ?? 900),
  );
  const margin = Math.max(0, options.bomb_margin ?? 26);
  const visible = (fruit, time) => {
    const p = screen(position(fruit, time, gravity), canvas),
      r =
        (fruit.r * canvas.width) /
        canvas.W /
        (canvas.camera?.active ? canvas.camera.zoom : 1);
    return (
      p.x + r * 0.78 > canvas.left + 1 &&
      p.x - r * 0.78 < canvas.left + canvas.width - 1 &&
      p.y + r * 0.78 > canvas.top + 1 &&
      p.y - r * 0.78 < canvas.top + canvas.height - 1
    );
  };
  // Let Wine sample mouse-down outside the fruit, and sample the endpoint
  // while still down. Otherwise a short path can fit between rendered frames.
  const warmup = maxDuration >= 160 && lead <= 350 ? 45 : 0,
    tail = warmup ? 45 : 0;
  if (warmup)
    base = planStroke(state, {
      ...options,
      lead_ms: lead + warmup,
      max_duration_ms: maxDuration - warmup - tail,
    });
  const fruits = state.fruits.filter(
    (f) => options.target_id == null || options.target_id === f.id,
  );
  let best = null,
    bestValue = -Infinity;
  function consider(path, strategy) {
    if (path.at(-1).t_ms > maxDuration || path.some((p) => !inside(p, canvas)))
      return;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1],
        b = path[i];
      if (
        b.t_ms <= a.t_ms ||
        (distance(a, b, canvas) / (b.t_ms - a.t_ms)) * 1000 > speed + 1e-6
      )
        return;
      if (
        !segmentSafe(
          a,
          elapsed + a.t_ms,
          b,
          elapsed + b.t_ms,
          state.bombs,
          gravity,
          margin,
        )
      )
        return;
    }
    const hits = hitsAlong(path, fruits, elapsed, gravity);
    if (!hits.length) return;
    const duration = path.at(-1).t_ms;
    const urgency = hits.reduce(
      (sum, f) => sum + Math.max(0, Math.min(1, f.y / canvas.H)),
      0,
    );
    const sorted = hits.toSorted((a, b) => a.hit_at_ms - b.hit_at_ms);
    let combo = 0,
      streak = 0,
      previous;
    for (const f of sorted) {
      if (
        previous &&
        ((f.wave ?? 0) !== (previous.wave ?? 0) ||
          f.hit_at_ms - previous.hit_at_ms > 90)
      ) {
        if (streak >= 3) combo += streak;
        streak = 0;
      }
      streak++;
      previous = f;
    }
    if (streak >= 3) combo += streak;
    const value =
      100 *
        hits.reduce(
          (sum, f) =>
            sum +
            Math.max(1, Math.min(100, f.reward ?? 1)) +
            (f.powerup ? 25 : 0),
          0,
        ) +
      100 * combo +
      4 * urgency -
      duration * 0.08 +
      (strategy === "combo-sweep" ? 8 : 0);
    if (value <= bestValue) return;
    bestValue = value;
    best = {
      ok: true,
      phase: state.phase,
      points: path.map((p) => ({ ...screen(p, canvas), t_ms: p.t_ms })),
      targets: hits.map((f) => f.id),
      start_at_ms: now + lead,
      lead_ms: lead,
      duration_ms: duration,
      fruits_seen: fruits.length,
      bombs_seen: state.bombs.length,
      gravity,
      strategy,
      predicted_hits: hits.length,
      predicted_combo_bonus: combo,
    };
  }
  if (base.ok) {
    const path = base.points.map((p) => ({
      ...world(p, canvas),
      t_ms: p.t_ms + warmup,
    }));
    if (warmup) path.unshift({ ...path[0], t_ms: 0 });
    if (tail) path.push({ ...path.at(-1), t_ms: path.at(-1).t_ms + tail });
    consider(path, "greedy-chain");
  }
  // Bound candidate search to keep planning comfortably below the input lead.
  const seeds = fruits
    .filter((f) => visible(f, elapsed + 100))
    .sort(
      (a, b) =>
        (b.powerup ? 10000 : 0) +
        (b.reward ?? 1) * 10 +
        b.y -
        ((a.powerup ? 10000 : 0) + (a.reward ?? 1) * 10 + a.y),
    )
    .slice(0, 10);
  const candidates = [];
  for (let i = 0; i < seeds.length; i++) {
    for (const angle of [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4]) {
      candidates.push([seeds[i], angle]);
      const center = position(seeds[i], elapsed + 100, gravity);
      if (
        state.bombs.some((b) => {
          const q = position(b, elapsed + 100, gravity);
          return (
            Math.hypot(center.x - q.x, center.y - q.y) <
            seeds[i].r + b.r + margin + 10
          );
        })
      ) {
        candidates.push(
          [seeds[i], angle, seeds[i].r * 0.72],
          [seeds[i], angle, -seeds[i].r * 0.72],
        );
      }
    }
    const a = position(seeds[i], elapsed + 100, gravity);
    for (let j = i + 1; j < seeds.length; j++) {
      const b = position(seeds[j], elapsed + 100, gravity);
      candidates.push([seeds[i], Math.atan2(b.y - a.y, b.x - a.x)]);
    }
  }
  for (const [seed, angle, shift = 0] of candidates) {
    const dx = Math.cos(angle),
      dy = Math.sin(angle),
      nx = -dy,
      ny = dx;
    for (const reverse of [false, true]) {
      let duration = 120,
        a,
        b;
      for (let iteration = 0; iteration < 3; iteration++) {
        let center = position(seed, elapsed + warmup + duration / 2, gravity);
        const projected = screen(center, canvas);
        center = world(
          {
            x: Math.max(
              canvas.left + 2,
              Math.min(canvas.left + canvas.width - 2, projected.x),
            ),
            y: Math.max(
              canvas.top + 2,
              Math.min(canvas.top + canvas.height - 2, projected.y),
            ),
          },
          canvas,
        );
        const offset = center.x * nx + center.y * ny + shift;
        let lo = Infinity,
          hi = -Infinity;
        for (const f of fruits) {
          const p = position(f, elapsed + warmup + duration / 2, gravity);
          if (
            !visible(f, elapsed + warmup + duration / 2) ||
            Math.abs(p.x * nx + p.y * ny - offset) > f.r * 0.78
          )
            continue;
          const along = p.x * dx + p.y * dy;
          lo = Math.min(lo, along - f.r - 10);
          hi = Math.max(hi, along + f.r + 10);
        }
        if (!Number.isFinite(lo)) break;
        a = { x: dx * lo + nx * offset, y: dy * lo + ny * offset };
        b = { x: dx * hi + nx * offset, y: dy * hi + ny * offset };
        // Clip the line to the live viewport, preserving its direction.
        let low = 0,
          high = 1;
        const sa = screen(a, canvas),
          sb = screen(b, canvas);
        for (const [key, min, max] of [
          ["x", canvas.left + 1, canvas.left + canvas.width - 1],
          ["y", canvas.top + 1, canvas.top + canvas.height - 1],
        ]) {
          const delta = sb[key] - sa[key];
          if (Math.abs(delta) < 1e-8) {
            if (sa[key] < min || sa[key] > max) {
              low = 1;
              high = 0;
            }
            continue;
          }
          const u = (min - sa[key]) / delta,
            v = (max - sa[key]) / delta;
          low = Math.max(low, Math.min(u, v));
          high = Math.min(high, Math.max(u, v));
        }
        if (low >= high) {
          a = null;
          break;
        }
        const end = {
          x: a.x + (b.x - a.x) * high,
          y: a.y + (b.y - a.y) * high,
        };
        a = { x: a.x + (b.x - a.x) * low, y: a.y + (b.y - a.y) * low };
        b = end;
        duration = Math.max(
          70,
          Math.ceil((distance(a, b, canvas) / speed) * 1000),
        );
      }
      if (!a || !b) continue;
      if (reverse) [a, b] = [b, a];
      const path = [{ ...a, t_ms: 0 }];
      if (warmup) path.push({ ...a, t_ms: warmup });
      path.push({ ...b, t_ms: warmup + duration });
      if (tail) path.push({ ...b, t_ms: warmup + duration + tail });
      consider(path, "combo-sweep");
    }
  }
  return best ?? { ok: false, reason: "no-safe-chain", phase: state.phase };
}
