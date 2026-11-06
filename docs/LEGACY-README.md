# Fruit Ninja MCP

A realtime Fruit Ninja browser game with two agent interfaces: structured application MCP and screenshot-only GUI. Both use the same game, physics, scoring and native mouse executor. The game keeps moving during inference, observations and input calls.

The evaluation runner uses local Codex CLI with `gpt-6.1-terra` / `high`. The best tested configuration is **coverage guidance + async execution + compact MCP feedback**; it must be selected explicitly. On held-out seeds 2026 / 7, it scored **225 / 357**, versus baseline MCP **55 / 25** and GUI with the same guidance and executor **28 / 68**. Each condition has one attempt per seed; these results do not establish a stable win rate. See [results and limitations](../RESULTS.md).

[Watch the optimized MCP recording](../recordings/optimized-seed42-v1/README.md): one uncut, original-speed take, 189 points.

## Setup and use

Requires Node.js 20.19+ and Chromium. The runtime checks `/usr/bin/chromium`, `/usr/bin/chromium-browser` and `/usr/bin/google-chrome`; set `FRUIT_NINJA_CHROMIUM` for another location. Setup downloads and verifies the pinned game; it does not install Chromium.

```sh
npm ci
npm run setup
npm run build

# Print an absolute-path MCP configuration to add to Codex.
node dist/cli.js codex-config --mcp-profile async --feedback compact

# Or start a stdio server directly; --headed requires a graphical display.
node dist/cli.js serve --mcp-profile async --feedback compact --headed --duration 60 --seed 42 --artifacts artifacts/manual

# Screenshot-only GUI interface.
node dist/cli.js serve --interface gui --mcp-profile async --headed --duration 60 --seed 42

# Play the unmodified upstream game manually, outside evaluation.
npm run play
```

The server prepares one round. Read the rules and inspect the ready screen before starting; after start, pause, reset and restart are disabled. Omit `--headed` for headless use. Standard output from `serve` contains only MCP protocol traffic. Defaults are `--interface mcp --mcp-profile standard --feedback full`, arcade mode and seed 42.

## Tools and action contract

| Application MCP                                                       | Screenshot GUI                                  |
| --------------------------------------------------------------------- | ----------------------------------------------- |
| `get_game_rules`: static rules and units                              | `get_controls`: static rules and mouse controls |
| `get_scene`: visible objects, velocities, radii, score and timestamps | `get_screenshot`: actual browser image          |
| `start_game`: start the prepared round                                | `click`: click the visible start button         |
| `swipe`: timed canvas path                                            | `drag`: timed full-image path                   |
| `wait`: wall-time sleep, then current state                           | `wait`: wall-time sleep, then screenshot        |
| `get_events`, `get_screenshot`                                        | No extracted application state                  |

The GUI driver also uses MCP transport: the comparison is application state versus pixels. GUI tools expose no OCR, DOM, accessibility tree or extracted text. Both interfaces use the same native mouse events and collision rules. MCP observations contain only currently visible objects, with no future spawns or RNG state.

Each path has **2–32 points**, starts at `t_ms: 0`, uses strictly increasing integer times and lasts **16–1000 requested ms**. Coordinates must be inside the relevant bounds; each segment is limited to **5000 px/s**. MCP uses canvas pixels with a top-left origin; GUI uses full-screenshot pixels. For example:

```json
{
  "points": [
    { "x": 200, "y": 350, "t_ms": 0 },
    { "x": 400, "y": 320, "t_ms": 100 },
    { "x": 600, "y": 350, "t_ms": 200 }
  ]
}
```

The executor interpolates actor-supplied coordinates, preserves every corner and releases the mouse after each path. It skips overdue interior samples; actual duration includes scheduling overhead and can exceed the requested duration. It never selects targets or replans. Optional MCP `expected_revision` detects intervening actions; it does not detect aging observations. `observed_at_ms` records observation age at acceptance.

| Option                             | Behavior                                                                                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--mcp-profile standard` (default) | Actions return after execution.                                                                                                                                                    |
| `--mcp-profile async`              | Replaces `swipe` / `drag` with `submit_swipe` / `submit_drag`; returns acceptance and a current observation while one fixed path executes. Busy requests accept and queue nothing. |
| `--mcp-profile fresh`              | Experimental MCP `observe` tool, visibility-triggered waits and public kinematic lifetime estimates. GUI retains standard behavior.                                                |
| `--feedback compact`               | MCP rounds positions, velocities and radii to one decimal, removes fruit names and scene diagnostics; full state remains in artifacts. GUI images are unchanged.                   |

Coverage guidance is an **actor prompt**, selected with `--policy coverage` in evaluation. For interactive use, ask the actor to choose useful 600–900ms paths when safe, account for stale observations, reuse action results and plan during async execution. The server supplies no sweep or aiming policy. See [optimization experiments](../OPTIMIZATION.md).

## Run comparisons and record video

Trials require an authenticated local `codex` CLI with access to the selected model. The recorded experiments used CLI 0.165.0. Build first, and give each run a new output directory.

```sh
# Sequential baseline pair: MCP, then GUI.
npm run compare -- --seed 42 --duration 60 --output artifacts/baseline-new

# Same coverage guidance and async executor in both arms.
npm run compare -- --policy coverage --mcp-profile async --feedback compact --seed 2026 --output artifacts/paired-new

# One optimized MCP trial.
npm run trial -- --policy coverage --mcp-profile async --feedback compact --seed 42 --duration 60 --output artifacts/optimized-new

# Six sequential 60-second trials on fixed held-out seeds 2026 and 7.
npm run validate:optimization -- --mcp-profile async --feedback compact --output artifacts/validation-new

# Record both arms, then export complete, original-speed MP4s.
npx playwright-core install ffmpeg
npm run compare -- --record-video --seed 42 --duration 60 --output artifacts/recorded-new
npm run export:video -- --trial artifacts/recorded-new/mcp
npm run export:video -- --trial artifacts/recorded-new/gui
```

MP4 export also requires `ffmpeg` and `ffprobe` on PATH. [The recorded pair](../recordings/seed42-v2/README.md) includes export hashes and frame validation.

The evaluator owns the game through a local HTTP MCP host independently of the actor connection. Each actor gets an empty workspace and only its assigned server; user configuration, project instructions, shell, web and multi-agent features are disabled. A started round continues to its natural end if the actor exits early. Artifacts retain prompts, arguments, fingerprints, native input timing, independent 100ms telemetry, screenshots, usage, errors and final scores. Raw artifacts are local and ignored by Git; committed summaries and videos link to their provenance. Realtime traces are timing evidence, not deterministic replay fixtures. See [the comparison protocol](../REALTIME-PROTOCOL.md).

## Code layout

| Path                                                   | Responsibility                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `src/cli.ts`, `src/server.ts`, `src/host.ts`           | CLI, interface-specific tools, evaluator-owned HTTP transport                           |
| `src/upstream.ts`, `src/bridge.ts`                     | Pinned game loading, in-memory instrumentation, realtime clock and visible-state bridge |
| `src/runtime.ts`, `src/pointer.ts`                     | Browser lifecycle, observations, shared native input, async ownership and telemetry     |
| `src/observation.ts`, `src/compact.ts`, `src/types.ts` | Fresh/compact feedback and shared types                                                 |
| `src/trial.ts`, `src/tool-audit.ts`, `scripts/`        | Actor isolation, evaluation, reporting and video export                                 |
| `tests/`, `results/`, `recordings/`                    | Automated checks, preserved experiment summaries and review videos                      |

## Game provenance and verification

The browser remake is [fruit-ninja-dojo](https://github.com/yongqixue99-hue/fruit-ninja-dojo), pinned to `63d0af1906181cceb9486ed85cc2b65ce6e6ba0d`, SHA-256 `6e072f6efc0f2bb69c98dede80ed524deda20f0004d27b7beb2e80f5c4ddf96f`. Setup stores its HTML in ignored `.local/game/`; launch verifies the hash and instruments it in memory. Changed integration anchors fail closed. Upstream source/art is not vendored or relicensed; verify dependency permissions before redistribution. This is not the official Halfbrick game.

The clock derives 120 Hz physics ticks from monotonic wall time and catches up after delayed callbacks. Both interfaces disable camera shake and visual slow motion; launch speeds, gravity and difficulty are preserved. Spawn RNG is separate from cosmetic randomness, while normal arcade frenzy can change later spawning through gameplay.

```sh
npm run typecheck
npm test
npm run build
npm run format:check
```

Run setup first. Tests use the actual game and Chromium to check wall-time progression, natural completion, native input, async ownership, GUI information boundaries and telemetry timing. The earlier decision-clock prototype is archived at `decision-prototype-v0.1.0`; its scores and tests are historical, and current source has no decision-step mode.
