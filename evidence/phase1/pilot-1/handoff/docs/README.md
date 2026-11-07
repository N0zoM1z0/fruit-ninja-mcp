# Fruit Ninja Dojo — MCP server

An application-level MCP server for the packaged browser game
`/opt/target/game/index.html` ("水果忍者 · 再来一刀", a Fruit Ninja remake).

It talks to the live game **only** through the game port (`FN_GAME_PORT`):

- `POST /v1/adapter` — runs `mcp/adapter.js` inside the game page to observe the
  arena and to plan a blade trajectory.
- `POST /v1/input/click` — one native left click (used to press the start button).
- `POST /v1/input/path` — one native mouse-down drag (the blade stroke).

No pixels, screenshots or generic mouse/keyboard primitives are exposed.

## Tools

| Tool          | Input                                                       | Mechanism                        |
| ------------- | ----------------------------------------------------------- | -------------------------------- |
| `game_state`  | –                                                           | `adapter:observe` (no input)     |
| `start_round` | –                                                           | one native click on the start button |
| `slice`       | optional `max_duration_ms`, `speed`, `bomb_margin`, `wait_ms` | `adapter:plan` + one native path |
| `slice_fruit` | `fruit_id` (+ the same optional knobs)                       | `adapter:plan` + one native path |

Every tool call issues **at most one** native input, as required.

If `slice` / `slice_fruit` is called while the round is still on the menu, it spends
that call's single input on the start button and reports `reason: "round-started"`;
the next call strikes.  `start_round` remains available for an explicit start.

## How the adapter observes the game

The game is a single IIFE; its state is not reachable from the page. The adapter
therefore reconstructs the world from the renderer, which the host explicitly
allows ("Canvas 2D rendering interfaces stay hookable"):

- `CanvasRenderingContext2D.prototype.drawImage` — every fruit is drawn from a
  320×320 offscreen sprite via `drawFruit()`. Reading the current transform gives
  the fruit centre `(e, f)` and the draw width gives its radius (`w * 124 / 320`).
  Calls made while a clip is active are the sliced halves (`drawPiece`), so they
  are ignored.
- `CanvasRenderingContext2D.prototype.fillRect` — while a round is running the
  only `fillRect` is the bomb's fuse base, `rect(-r*.22, -r*1.12, r*.43, r*.26)`
  in the bomb's local frame. Its aspect ratio identifies it and `w / 0.43`
  recovers the bomb radius.
- `save` / `restore` / `clip` — a small clip-depth stack, used only to tell
  entities from debris.
- `clearRect` — marks a frame boundary; each completed frame is fed to a
  nearest-neighbour tracker.

Score, lives, clock and phase come from the HUD DOM (`#score`, `#lives`,
`#time`, `#menu`, `#hud`, `#result-dialog`, `#mode-label`), which the game keeps
up to date every tick.

Nothing is written back: the hooks only read.

## How the blade is planned

For each tracked fruit the adapter fits `x = x0 + vx·t` and
`y = y0 + vy·t + ½g·t²` (with `g = H·1.03`, the game's own gravity) over a
~0.4 s window of render samples, then propagates the fitted velocity to the
newest sample. It then greedily chains fruits (nearest-first, starting from the
fruit closest to the bottom centre) and emits one path point per fruit at the
fruit's predicted position at the arrival time. Segments that would pass within
`bomb_r·0.83 + margin` of a bomb are rejected and that fruit is skipped.

Two timing details matter a lot and are handled explicitly:

1. **The native executor emits roughly one mouse sample per CDP round trip.**
   A path segment shorter than that round trip is stretched in wall time, so the
   blade falls behind the fruit. The planner therefore enforces a minimum
   per-segment duration (`step_ms`) and the server calibrates it from the
   `actual_duration_ms` reported by the port after every stroke.
2. **The blade reaches a planned point about one round trip late.** The planner
   is given a `lead_ms` offset so that the point it aims at is where the fruit
   will be when the blade actually gets there.

The path is finally clamped into the canvas rectangle (the only element that
receives the blade — points outside it produce no `pointerdown`), forced to
strictly increasing integer `t_ms`, given a ≥20 ms duration and checked against
the 5000 px/s cap.

## Layout

```
mcp/launch.sh   executable entry point (stdio)
mcp/server.js   MCP server: tools, port client, timing calibration
mcp/adapter.js  in-page observer + planner (evaluated by the host)
mcp/deps/       dependency notes (none vendored)
```
