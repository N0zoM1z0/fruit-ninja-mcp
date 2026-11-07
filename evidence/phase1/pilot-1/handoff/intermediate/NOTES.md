# Exploration notes — Fruit Ninja Dojo

## Target

`/opt/target/game/index.html` — a single-file Fruit Ninja remake (Canvas 2D, 855 lines,
one IIFE).  The host loads it with `page.setContent`, calls `window.__fnPrepare({mode, seed,
duration_seconds})` once, applies the lockdown, then evaluates the adapter.

## What the game does (from reading the source)

* 120 Hz fixed-step physics driven by the monotonic wall clock (`reefPump`, called from
  `requestAnimationFrame` and a `setInterval(8ms)`).  Nothing can pause or advance it.
* Fruits are launched from below the arena with `vy = -sqrt(2*g*(y-peak))`, `g = H*1.03`,
  and are airborne ~2.4 s.  Waves of 3–5 fruits spawn every 1.48–1.82 s (0.64 s during
  frenzy), from a seeded LCG (`seed = (seed*1664525 + 1013904223) >>> 0`).
* Bombs spawn from wave 3 on (45 % classic / 40 % arcade) at `x = r*1.65` or `W - r*1.65`,
  i.e. hard against the left/right edges, with `vx = 0`.
* Slicing: `pointerdown` starts a stroke (requires `isTrusted`, `button === 0`, phase
  `playing`); each `pointermove` tests the segment from the previous pointer position to the
  new one against every entity, `distance <= r * 1.02` (bombs `r * 0.83`).
* Scoring: +1 per fruit (+2 in frenzy); a stroke of n ≥ 3 fruits adds a bonus of n.
  Combo gap is 0.34 s.  Arcade: 60 s, bombs −10.  Classic: 3 misses or a bomb ends the run.
  Zen: 90 s, no bombs, no miss penalty.
* Only a native click on `#start-button` starts the round; pause/home/restart are disabled.

## Observation strategy

The game state lives in a closure and is unreachable.  The host explicitly permits wrapping
Canvas 2D rendering interfaces, so the adapter reconstructs the world from draw calls:

* `drawImage` with a 320×320 source = a fruit; the current transform gives the centre and
  `dw * 124 / 320` the radius.  Calls made while a clip is active are the sliced halves.
* `fillRect` while a round runs = the bomb's fuse base (`r*.43 × r*.26`); its aspect ratio
  identifies it and `w / 0.43` recovers the radius.
* `clearRect` marks frame boundaries; frames feed a nearest-neighbour tracker whose samples
  are least-squares fitted to `x = x0 + vx·t`, `y = y0 + vy·t + ½g·t²`.

HUD DOM (`#score`, `#lives`, `#time`, `#menu`, `#hud`, `#result-dialog`, `#mode-label`)
supplies score / lives / clock / phase.

## Two bugs found while testing (both fixed)

1. **Unit mix.**  `performance.now()` is milliseconds but the planner treated the lead as
   seconds, so `T0 = now + 0.027` — the lead was effectively zero and every prediction was
   ~30 px stale.  All internal times are now milliseconds.
2. **Velocity reference time.**  The least-squares fit reports the velocity at the *oldest*
   sample in the window, but it was used as the velocity *now*.  Over a 0.4 s window with
   `g = 841 px/s²` that is a ~340 px/s error.  The fitted velocity is now propagated to the
   newest sample and predictions are made against absolute page time.

## The dominant practical constraint: executor latency

The port's `executeTimedPath` emits one mouse sample per ~8 ms of path time, but each
`page.mouse.move` is a CDP round trip.  Measured here at ~40 ms, so:

* a path whose segments are shorter than the round trip is stretched in wall time and the
  blade falls behind the fruit (observed 3× stretch on a 68 ms path);
* the blade reaches a planned point about one round trip late.

The planner therefore enforces a minimum per-segment duration (`step_ms`) and the server
calibrates `step_ms` / `lead_ms` from the `actual_duration_ms` the port reports after every
stroke.  With that in place the blade tracks the fruit and strokes stop missing.

## Measured results (this sandbox, `fn-port`)

| mode    | duration | score | notes |
| ------- | -------- | ----- | ----- |
| arcade  | 60 s     | 1284–1323 | ~89 strokes, 0 misses |
| classic | 63 s     | 340   | 0 misses, never touched a bomb |
| zen     | 69 s     | 342   | 0 misses |

Parameter sweep (`gained` over 30 strokes, arcade):

| lead / step | gained | zero-gain strokes |
| ----------- | ------ | ----------------- |
| 30 / 30     | 224    | 0 |
| 45 / 40     | 310    | 1 |
| 60 / 50     | 372    | 0 |
| 70 / 70     | 412    | 0 |
| 80 / 60     | 400    | 1 |
| 100 / 80    | 412    | 1 |
| 120 / 100   | 374    | 1 |

## Files here

* `probe-adapter.js` — first-pass adapter that dumped raw draw calls (used to identify the
  sprite/bomb signatures).
* `diag-adapter.js` — the shipped adapter plus passive pointer-event logging, used to
  measure the executor's real sample timing.
* `pc.mjs`, `start-port.sh`, `mcp.sh` — port / MCP drivers.
* `test1..test8.mjs`, `calib.mjs`, `agent.mjs`, `final.mjs` — experiments.
* `patch1..patch7.mjs` — the edits applied to the adapter/server while iterating.
