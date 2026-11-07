# Game port

HTTP/1.1 with JSON bodies over the unix socket in `FN_GAME_PORT`
(`/run/fn/port.sock` at play time). Successful replies contain `"ok": true`; failures contain
`"ok": false` and `{"error": {"code", "message"}}`. The port returns no game state of its
own: no scores, objects, events or images.

| Request                | Body                                           | Result                                                              |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| `GET /v1/info`         |                                                | viewport, coordinate system, input limits, profile, adapter exports |
| `GET /v1/status`       |                                                | generic executor status: pending and previous action                |
| `POST /v1/adapter`     | `{"fn": "name", "args": <json>}`               | `{"value": <json>}` returned by your adapter                        |
| `POST /v1/input/path`  | `{"points": [{"x","y","t_ms"}], "wait": true}` | executes one native mouse-down path, then mouse-up                  |
| `POST /v1/input/click` | `{"x", "y"}`                                   | one native left click                                               |

**Coordinates** are page CSS pixels of the 1440x960 viewport, origin top-left.

**Paths** have 2–32 points; `t_ms` is an integer that starts at 0 and strictly increases; a
path lasts 16–1000 ms; every segment is at most 5000 px/s. The executor interpolates your
points on wall time and never aims or replans. One path executes at a time; a request while
busy is rejected (`BUSY`) and nothing is queued. In the `standard` profile a path request
returns after mouse-up; in the `async` profile `"wait": false` returns at acceptance.

**Input budget** at play time: one input (path or click) per player tool call, and none outside
a tool call (`INPUT_BUDGET_EXCEEDED`, `NO_ACTIVE_TOOL_CALL`).

**Adapter.** If `manifest.json` names `"adapter": "mcp/adapter.js"`, the host evaluates that file
once in the page's main world after the game has initialized and the round is prepared, as a
CommonJS-style module body: assign functions to `exports` (or `module.exports`). `POST
/v1/adapter` calls `exports[fn](args)` (it may be async) with a 2 s limit. Results must be JSON,
at most 256 KiB, and must not contain image data (`PIXELS_WITHHELD`). Before your adapter runs,
the host freezes JavaScript and DOM built-ins (Canvas 2D rendering interfaces stay wrappable),
removes script elements and host hooks, and the page forbids `eval`/`new Function` and all
network access.

**Errors** include `BAD_REQUEST`, `INVALID_PATH`, `INVALID_CLICK`, `BUSY`, `ROUND_NOT_PLAYING`,
`ADAPTER_MISSING`, `ADAPTER_ERROR`, `ADAPTER_TIMEOUT`, `RESULT_TOO_LARGE`, `PIXELS_WITHHELD`,
`INPUT_BUDGET_EXCEEDED`, `NO_ACTIVE_TOOL_CALL` and `NOT_FOUND`.

During building, `fn-port --adapter /output/mcp/adapter.js --socket /work/port.sock` serves the
same API with a fresh game (no input budget), so you can run
`FN_GAME_PORT=/work/port.sock /output/mcp/launch.sh` against it.
