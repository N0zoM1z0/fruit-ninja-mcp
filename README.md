# Fruit Ninja MCP

**Realtime application MCP versus screenshot-only GUI**, using the same rendered Fruit Ninja game, game speed, seeded physics/scoring and native browser mouse executor. Local Codex CLI runs `gpt-6.1-terra` with `high` reasoning in both arms.

Once a round starts, fruit keep moving during model inference, screenshots, observations, input calls, focus changes and actor disconnects. No tool advances or freezes time. The evaluator owns the game independently of the actor. See [the comparison protocol](REALTIME-PROTOCOL.md) and [results](RESULTS.md).

The current recommended configuration uses **coverage guidance, async execution and compact feedback**. In the primary held-out 60-second tests, optimized MCP scored **225 / 357**, matched baseline MCP **55 / 25**, and GUI with equivalent guidance and input capabilities **28 / 68**. All six clock/interface audits passed. These are small-sample results; see [the full evidence and limitations](RESULTS.md#current-optimized-configuration-held-out-validation).

[Watch the optimized MCP recording](recordings/optimized-seed42-v1/README.md): 189 points in one original-speed, uncut recorded take.

The former decision-clock prototype is archived at Git tag `decision-prototype-v0.1.0`. Its 360/300-point scores are **not realtime evidence**. Current source has no decision-step mode.

## Setup

Requires Node.js 20.19+ and Chromium (`/usr/bin/chromium` on this machine). Set `FRUIT_NINJA_CHROMIUM` for another executable path.

```sh
npm ci
npm run setup
npm run build
node dist/cli.js codex-config
```

The last command prints an absolute-path MCP configuration for Codex. The server prepares one arcade round; the agent reads the rules, inspects the scene and calls `start_game` when ready. Pauses, resets and restarts are disabled after starting.

```sh
# MCP stdio server with an optional visible game window.
node dist/cli.js serve --headed --duration 60 --seed 42 --artifacts artifacts/manual

# Screenshot-only GUI tools over stdio.
node dist/cli.js serve --interface gui --headed --duration 60 --seed 42

# Play the unmodified upstream game manually (separate from evaluation).
npm run play
```

Omit `--headed` without a graphical display. Standard output on `serve` contains only MCP protocol traffic. Evaluation uses an independently owned local HTTP MCP host so that closing the actor connection does not terminate the game.

## Interfaces

| Application MCP                                                                  | Screenshot GUI                                            |
| -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `get_game_rules`: static rules and units                                         | `get_controls`: the same static rules plus mouse controls |
| `get_scene`: visible objects, positions, velocities, radii, score and timestamps | `get_screenshot`: real browser image only                 |
| `start_game`: start the prepared round                                           | `click`: ordinary mouse click on the visible start button |
| `swipe`: actor-authored timed canvas path                                        | `drag`: actor-authored timed full-image mouse path        |
| `wait`: sleep in wall time, then return current state                            | `wait`: sleep in wall time, then return an image          |
| `get_events`, optional `get_screenshot`                                          | Action results contain images with no extracted state     |

The GUI driver also uses MCP as transport. This compares application information with pixels, not two protocols. Both arms use identical native mouse events, collision rules and path limits. There is no OCR, DOM, accessibility or extracted text in the GUI interface. Only the independent evaluator can inspect its hidden game state.

Every path has 2–32 points, lasts 16–1000 requested milliseconds, and is limited to 5000 px/s. Its real execution time is recorded; scheduling overhead is not removed from game time. All corners are preserved. The executor never selects targets, tracks fruit or replans a path.

The shared executor adapts interior samples to elapsed wall time instead of replaying samples whose scheduled time has passed. Every actor-supplied corner is still emitted, with the speed limit enforced. Native input acknowledgements are measured and per-sample logging is buffered until mouse-up. Canvas geometry is cached for the fixed viewport. These changes apply identically to both interfaces.

```json
{
  "points": [
    { "x": 200, "y": 350, "t_ms": 0 },
    { "x": 400, "y": 320, "t_ms": 100 },
    { "x": 600, "y": 350, "t_ms": 200 }
  ]
}
```

This is a coordinate example, not a built-in strategy. MCP paths use canvas pixels, origin upper left; GUI paths use full-screenshot pixels. The MCP response includes the arena dimensions and px/s velocities. Optional `observed_at_ms` records how old an MCP observation was at action acceptance. A revision protects against another action, not the passage of time.

## Optimization profiles

`--mcp-profile async` replaces `swipe` with `submit_swipe` (GUI: `drag` with `submit_drag`). The tool returns acceptance and a current observation while the single submitted native path continues, allowing the model to plan during execution. A busy submission accepts nothing and queues nothing. Every path still ends in mouse-up within the same bounded action contract. MCP receives visible state; GUI receives pixels plus generic executor status only.

`--feedback compact` reduces numeric display precision to 0.1 pixels and omits diagnostic fields and fruit names from MCP responses. Full precision and clock audits remain in independent artifacts. `--mcp-profile fresh` adds visibility-triggered real-time observation waits and public kinematic lifetime estimates. These experimental options are retained even when they score worse; see [optimization evidence](OPTIMIZATION.md).

```sh
# Configure interactive Codex with execution/planning overlap.
node dist/cli.js codex-config --mcp-profile async --feedback compact

# Reproduce the latency-aware coverage policy with local Terra/high; no video.
npm run trial -- --policy coverage --mcp-profile async --feedback compact --seed 42 --duration 60 --output artifacts/optimized-new

# Apply identical coverage guidance and overlap capability to both interfaces.
npm run compare -- --policy coverage --mcp-profile async --feedback compact --seed 2026 --output artifacts/paired-new

# Sequential validation: baseline MCP, selected MCP and selected GUI on seeds 2026 and 7.
npm run validate:optimization -- --mcp-profile async --feedback compact --output artifacts/validation-new
```

The coverage policy asks the actor to author longer useful paths, reuse observations, reduce idle waits and seek combos/frenzy. It supplies no coordinates or target choices. For interactive use, give the same guidance to the actor: plan deliberate continuous 600–900ms paths when safe, choose every vertex from observations, account for stale state, reuse the submission result and plan immediately while the current path executes. The server has no automatic sweep, homing or gameplay controller.

## Realtime comparison

```sh
# One sequential paired baseline: same model, seed, speed, duration and limits.
npm run compare -- --seed 42 --duration 60 --output artifacts/comparisons/realtime-baseline-42

# One arm for diagnostics.
npm run trial -- --interface gui --seed 42 --duration 60 --output artifacts/gui-diagnostic

# Record one full realtime game in each arm; retain original-speed raw WebM.
npm run compare -- --record-video --seed 42 --duration 60 --output artifacts/comparisons/recorded-42
npm run export:video -- --trial artifacts/comparisons/recorded-42/mcp
npm run export:video -- --trial artifacts/comparisons/recorded-42/gui
```

The runner disables user configuration, project instructions, shell, web and multi-agent features. Each actor has an empty workspace and only its assigned server. The GUI starts by clicking; MCP starts through its native start tool. Both may inspect the ready screen before starting. If the actor exits early, the independent game continues to its natural end and is still graded. A setup timeout, late shutdown, invalid interface or clock problem is retained explicitly.

Evidence includes prompts, exact arguments, model/CLI settings, source/build/game fingerprints, timestamped native mouse events, independent 100ms state telemetry, screenshots, errors, usage and final scores. The final game state is authoritative. Real-time traces are timing evidence, not deterministic decision-step replay fixtures.

Video export preserves original speed and the complete uncut capture, including setup, the entire round and the final result. No trimming or time scaling is applied; source video and export hashes remain available.

Recording also requires Playwright's FFmpeg build (`npx playwright-core install ffmpeg`); MP4 export requires `ffmpeg` and `ffprobe` on PATH. The [recorded pair](recordings/seed42-v2/README.md) has original-speed full-game MP4 files and provenance.

## Clock and game provenance

The clock derives 120 Hz physics ticks from browser monotonic wall time. A timer independent of rendering and actor input pumps the world; delayed callbacks catch up instead of dropping elapsed time. Tests check idle progression, natural wall-time completion, continuing time during screenshots/focus changes, disabled pauses and game survival after actor disconnection. Camera shake and visual slow motion are disabled identically in both arms; launch speeds, gravity and difficulty are not reduced.

The game is [fruit-ninja-dojo](https://github.com/yongqixue99-hue/fruit-ninja-dojo), pinned to `63d0af1906181cceb9486ed85cc2b65ce6e6ba0d`. Setup downloads its self-contained HTML to ignored `.local/game/` and verifies SHA-256 `6e072f6efc0f2bb69c98dede80ed524deda20f0004d27b7beb2e80f5c4ddf96f`. Launch verifies the pin and instruments the game in memory; changed anchors fail closed. Spawn RNG is separated from cosmetic randomness. Gameplay frenzy can still change later spawning through normal rules.

Upstream source/art is not vendored or relicensed. Its repository currently has no explicit license file; this private prototype uses a separately fetched dependency. Confirm permission or replace the dependency before redistributing it. This is a browser remake, not the official Halfbrick game.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm run format:check
```

Run setup first. Tests use the actual game and Chromium, including native mouse hits, wall-time progression, natural deadlines, GUI capability boundaries and independent runtime ownership. Historical decision-clock tests and replay code remain available at the archived tag.
