/**
 * Native adaptation of the Phase 1 adapter's ballistic, greedy-chain strategy.
 * Pure function: no game input, process reads, wall-clock reads or browser hooks.
 * Positions/radii are game pixels, velocities game pixels/second and gravity
 * game pixels/second². Canvas maps game coordinates to native screen pixels.
 */
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const finite = (n) => typeof n === "number" && Number.isFinite(n);
export { position, screen, world, inside, distance, segmentSafe };

function position(entity, elapsedMs, gravity) {
  const dt = (elapsedMs + (entity.age_ms ?? 0)) / 1000;
  const g = entity.gravity ?? gravity;
  return {
    x: entity.x + entity.vx * dt,
    y: entity.y + entity.vy * dt + 0.5 * g * dt * dt,
  };
}

function screen(point, canvas) {
  const camera = canvas.camera;
  if (camera?.active) {
    const x = (point.x - canvas.W / 2 - camera.x) / camera.zoom,
      y = (canvas.H / 2 - point.y - camera.y) / camera.zoom;
    const c = Math.cos(camera.angle),
      s = Math.sin(camera.angle);
    point = {
      x: canvas.W / 2 + c * x - s * y,
      y: canvas.H / 2 - (s * x + c * y),
    };
  }
  return {
    x: canvas.left + (point.x * canvas.width) / canvas.W,
    y: canvas.top + (point.y * canvas.height) / canvas.H,
  };
}

function world(point, canvas) {
  let x = ((point.x - canvas.left) * canvas.W) / canvas.width - canvas.W / 2;
  let y = canvas.H / 2 - ((point.y - canvas.top) * canvas.H) / canvas.height;
  const camera = canvas.camera;
  if (camera?.active) {
    const u = x,
      v = y;
    const c = Math.cos(camera.angle),
      s = Math.sin(camera.angle);
    x = camera.zoom * (c * u + s * v) + camera.x;
    y = camera.zoom * (-s * u + c * v) + camera.y;
  }
  return { x: x + canvas.W / 2, y: canvas.H / 2 - y };
}

function inside(point, canvas) {
  // Keep native input off window borders. Reject rather than clamp: clamping a
  // predicted intercept changes both its hit position and its bomb clearance.
  const pixel = screen(point, canvas);
  if (
    pixel.x < canvas.left + (60 * canvas.width) / 1024 &&
    pixel.y > canvas.top + canvas.height - (70 * canvas.height) / 768
  )
    return false;
  if (canvas.camera?.active) {
    const p = screen(point, canvas);
    return (
      p.x >= canvas.left + 1 &&
      p.x <= canvas.left + canvas.width - 1 &&
      p.y >= canvas.top + 1 &&
      p.y <= canvas.top + canvas.height - 1
    );
  }
  return (
    point.x >= canvas.W / canvas.width &&
    point.x <= canvas.W * (1 - 1 / canvas.width) &&
    point.y >= canvas.H / canvas.height &&
    point.y <= canvas.H * (1 - 1 / canvas.height)
  );
}

function distance(a, b, canvas) {
  const pa = screen(a, canvas),
    pb = screen(b, canvas);
  return Math.hypot(pb.x - pa.x, pb.y - pa.y);
}

function originDistance(a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const den = dx * dx + dy * dy;
  const u = den ? clamp(-(a.x * dx + a.y * dy) / den, 0, 1) : 0;
  return Math.hypot(a.x + dx * u, a.y + dy * u);
}

function segmentSafe(a, ta, b, tb, bombs, gravity, margin) {
  // Examine relative-motion chords, padded by the exact maximum deviation of
  // a ballistic arc from its chord. This also catches fast bombs between input
  // samples, unlike checking only the ends of a stroke.
  const steps = Math.max(1, Math.ceil((tb - ta) / 8));
  for (const bomb of bombs) {
    const g = bomb.gravity ?? gravity;
    for (let i = 0; i < steps; i++) {
      const u = i / steps,
        v = (i + 1) / steps;
      const t0 = ta + (tb - ta) * u,
        t1 = ta + (tb - ta) * v;
      const p0 = position(bomb, t0, gravity),
        p1 = position(bomb, t1, gravity);
      const r0 = {
        x: a.x + (b.x - a.x) * u - p0.x,
        y: a.y + (b.y - a.y) * u - p0.y,
      };
      const r1 = {
        x: a.x + (b.x - a.x) * v - p1.x,
        y: a.y + (b.y - a.y) * v - p1.y,
      };
      const curvePad = (Math.abs(g) * ((t1 - t0) / 1000) ** 2) / 8;
      if (originDistance(r0, r1) <= bomb.r + margin + curvePad) return false;
    }
  }
  return true;
}

/**
 * Plan one mouse-down stroke. The executor first moves to points[0] with the
 * button UP, waits until start_at_ms, then follows t_ms relative to mouse-down.
 * options.now_ms may advance the scene clock to account for transport latency.
 * Gravity must come from RE/runtime evidence: state.gravity or options.gravity.
 */
export function planStroke(state, options = {}) {
  const fail = (reason) => ({
    ok: false,
    reason,
    phase: state?.phase ?? "unknown",
  });
  const canvas = state?.canvas;
  const gravity = options.gravity ?? state?.gravity;
  if (!finite(gravity)) return fail("missing-gravity");
  if (
    !canvas ||
    !["left", "top", "width", "height", "W", "H"].every((k) =>
      finite(canvas[k]),
    ) ||
    canvas.width <= 2 ||
    canvas.height <= 2 ||
    canvas.W <= 0 ||
    canvas.H <= 0 ||
    !finite(state.now) ||
    !Array.isArray(state.fruits) ||
    !Array.isArray(state.bombs)
  )
    return fail("invalid-state");
  if (state.phase != null && state.phase !== "playing")
    return fail("not-playing");
  if (
    canvas.camera?.active &&
    (!["x", "y", "zoom", "angle"].every((k) => finite(canvas.camera[k])) ||
      canvas.camera.zoom <= 0.05 ||
      canvas.camera.zoom > 10)
  )
    return fail("invalid-state");
  if (
    ![...state.fruits, ...state.bombs].every(
      (e) =>
        e &&
        e.id != null &&
        ["x", "y", "r", "vx", "vy"].every((k) => finite(e[k])) &&
        e.r > 0 &&
        (e.age_ms == null || (finite(e.age_ms) && e.age_ms >= 0)) &&
        (e.gravity == null || finite(e.gravity)),
    )
  )
    return fail("invalid-entities");
  for (const key of [
    "now_ms",
    "lead_ms",
    "speed",
    "max_duration_ms",
    "step_ms",
    "bomb_margin",
    "max_age_ms",
  ]) {
    if (options[key] != null && !finite(options[key]))
      return fail("invalid-options");
  }
  const now = options.now_ms ?? state.now;
  if (now < state.now) return fail("invalid-clock");
  const lead = clamp(options.lead_ms ?? 45, 0, 400);
  const speed = clamp(options.speed ?? 3200, 600, 4800);
  const maxDuration = clamp(options.max_duration_ms ?? 900, 20, 1000);
  const step = clamp(options.step_ms ?? 40, 20, 200);
  const margin = Math.max(0, options.bomb_margin ?? 26);
  const maxAge = Math.max(0, options.max_age_ms ?? 250);
  if (
    [...state.fruits, ...state.bombs].some(
      (e) => now - state.now + (e.age_ms ?? 0) > maxAge,
    )
  )
    return fail("stale-state");
  const startElapsed = now - state.now + lead;
  const candidates = state.fruits.filter(
    (e) =>
      (options.target_id == null || e.id === options.target_id) &&
      inside(position(e, startElapsed, gravity), canvas),
  );
  if (!candidates.length) return fail("no-fruits");

  const used = new Set(),
    chain = [];
  let current = null,
    currentTime = startElapsed,
    entry = null;
  while (used.size < candidates.length) {
    const anchor = current ?? { x: canvas.W / 2, y: canvas.H };
    let best = null,
      bestDistance = Infinity;
    for (const fruit of candidates) {
      if (used.has(fruit.id)) continue;
      const d = distance(anchor, position(fruit, currentTime, gravity), canvas);
      if (d < bestDistance) {
        best = fruit;
        bestDistance = d;
      }
    }
    if (!best) break;
    used.add(best.id);
    let t = startElapsed;
    let origin = current,
      originTime = currentTime;
    if (!current) {
      // Native collision tests require crossing the sphere surface. A stroke
      // that begins and remains inside a fruit does not cut it.
      const center = position(best, startElapsed, gravity),
        reach = best.r + 8;
      const starts = [
        { x: center.x - reach, y: center.y },
        { x: center.x + reach, y: center.y },
        { x: center.x, y: center.y - reach },
        { x: center.x, y: center.y + reach },
      ];
      origin = null;
      for (const start of starts) {
        if (!inside(start, canvas)) continue;
        let arrival = startElapsed + step;
        for (let i = 0; i < 8; i++)
          arrival =
            startElapsed +
            Math.max(
              step,
              Math.ceil(
                (distance(start, position(best, arrival, gravity), canvas) /
                  speed) *
                  1000,
              ),
            );
        const hit = position(best, arrival, gravity);
        if (
          inside(hit, canvas) &&
          segmentSafe(
            start,
            startElapsed,
            hit,
            arrival,
            state.bombs,
            gravity,
            margin,
          )
        ) {
          origin = start;
          originTime = startElapsed;
          t = arrival;
          break;
        }
      }
      if (!origin) continue;
    } else {
      t = currentTime + step;
      for (let i = 0; i < 8; i++)
        t =
          currentTime +
          Math.max(
            step,
            Math.ceil(
              (distance(current, position(best, t, gravity), canvas) / speed) *
                1000,
            ),
          );
    }
    const p = position(best, t, gravity);
    if (t - startElapsed > maxDuration || !inside(p, canvas)) continue;
    // Recheck after fixed-point iteration; an uncatchable fast target can make
    // the iteration oscillate rather than meet the native speed constraint.
    if (distance(origin, p, canvas) / ((t - originTime) / 1000) > speed + 1e-6)
      continue;
    if (!segmentSafe(origin, originTime, p, t, state.bombs, gravity, margin))
      continue;
    if (!current) entry = origin;
    chain.push({ id: best.id, point: p, t });
    current = p;
    currentTime = t;
  }
  if (!chain.length) return fail("no-safe-chain");

  const path = [
    { ...entry, t_ms: 0 },
    ...chain.map((c) => ({ ...c.point, t_ms: Math.round(c.t - startElapsed) })),
  ];
  // Validate the actual rounded schedule and all segments that will be emitted.
  // Rounding must not silently stretch time after predicting a moving target.
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1],
      b = path[i];
    const dt = b.t_ms - a.t_ms;
    if (
      dt <= 0 ||
      distance(a, b, canvas) / (dt / 1000) > speed + 1e-6 ||
      !segmentSafe(
        a,
        startElapsed + a.t_ms,
        b,
        startElapsed + b.t_ms,
        state.bombs,
        gravity,
        margin,
      )
    )
      return fail("unsafe-final-path");
  }
  return {
    ok: true,
    phase: state.phase ?? "playing",
    points: path.map((p) => ({ ...screen(p, canvas), t_ms: p.t_ms })),
    targets: chain.map((c) => c.id),
    start_at_ms: now + lead,
    lead_ms: lead,
    duration_ms: path[path.length - 1].t_ms,
    fruits_seen: candidates.length,
    bombs_seen: state.bombs.length,
    gravity,
  };
}
