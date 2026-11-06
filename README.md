# Fruit Ninja MCP

A real, rendered Fruit Ninja game that an agent plays through visible-object state and timed blade trajectories. The intended showcase compares application MCP with screenshot-only vision: both use the same game, physics and collision rules.

The first milestone is a useful MCP interface and an actual local Codex CLI trial. This repository does not yet contain a vision benchmark or a recorded demo.

The [local trial results](RESULTS.md) include two completed Terra/high playthroughs: **360 points / 100 sliced fruit** and **300 points / 85 sliced fruit**, with no escaped fruit, bomb hits or tool errors. These are MCP-only exploratory runs using the decision clock described below.

## Quick start

Requires Node.js 20.19+ and Chromium. On this machine Chromium is `/usr/bin/chromium`; elsewhere set `FRUIT_NINJA_CHROMIUM` to its executable path.

```sh
npm ci
npm run setup
npm run build
node dist/cli.js codex-config
```

The last command prints an absolute-path Codex configuration using `gpt-6.1-terra` and `high` reasoning. Add that MCP entry to your Codex configuration. Start a conversation with “Play Fruit Ninja, maximize score, and finish the round.” The agent can start its own seeded game.

```sh
# Play the original game with a mouse in a normal browser window.
npm run play

# MCP server over stdio; optional visible browser and artifact directory.
node dist/cli.js serve --headed --artifacts artifacts/manual
```

Omit `--headed` on a machine without a graphical display. Standard output on `serve` is exclusively MCP protocol traffic.

## Tools

| Tool             | Purpose                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `get_game_rules` | Units, clock, physics, scoring, limits and workflow                                          |
| `new_game`       | Start/reset a round with mode and seed; optional 5–90 second arcade/zen duration             |
| `get_scene`      | Current visible fruit/bombs, stable IDs, positions, velocities, hit radii and score          |
| `swipe`          | One continuous blade-down polyline with timestamps; advances the world while the blade moves |
| `wait`           | Advance with the blade lifted; optionally stop as soon as an object is visible               |
| `get_events`     | Slice, bomb, escape and round-finish events with sequence numbers                            |
| `get_screenshot` | The actual rendered game without advancing time                                              |

Every action returns the next scene, so an agent can plan its next action without an extra observation call. `expected_revision` rejects stale actions before execution. Paths are validated completely before any input or time advance. Calls execute serially.

Coordinates are **canvas pixels**, origin upper left; velocities are px/s and gravity is px/s². The screenshot includes the surrounding page, so canvas coordinates differ from whole-image coordinates. Arena dimensions are present in every scene. A swipe uses 2–32 points, lasts 16–1000 ms, and is limited to 5000 px/s. For example, after observing a scene, the agent submits its own path:

```json
{
  "expected_revision": 4,
  "points": [
    { "x": 200, "y": 350, "t_ms": 0 },
    { "x": 400, "y": 320, "t_ms": 100 },
    { "x": 600, "y": 350, "t_ms": 200 }
  ]
}
```

This is a path example, not a preselected target or a built-in strategy. A path through a bomb hits the bomb. All blade samples use the game's existing pointer handlers and collision detector. The server has no object-ID slicing, automatic aiming, path planner, arbitrary JavaScript tool, score setter or future-spawn access.

## Clock and reproducibility

The current MCP uses an explicit **decision clock**: thinking, tool discovery, observation and screenshots freeze the world. Only `wait` and `swipe` consume simulation time. Fruit continue moving during a swipe, with fixed 120 Hz physics. Durations round up to the next physics tick. Camera shake and cinematic slow motion are disabled; the fruit art, juice, halves, blade trail, combos and game scoring remain.

This makes LLM play useful without requiring a model response at 60 Hz. It is **not a real-time reaction benchmark**. The runner records actual wall time separately. Any future vision comparison must use the same decision clock, game settings, model and seeded starting conditions.

Spawning has a dedicated seeded RNG and sequential object IDs. Cosmetic particle randomness cannot perturb the next wave. Gameplay effects such as arcade frenzy can still change spawning according to the game's normal rules. Observations contain only objects intersecting the viewport, with no RNG state or spawn schedule.

## Codex CLI trial

```sh
npm run trial -- --duration 20 --seed 42 --output artifacts/trials/terra-high-42
```

The runner starts the installed local Codex CLI with `gpt-6.1-terra`, `model_reasoning_effort="high"`, a required MCP server and a single already-started arcade round. User configuration, shell and multi-agent features, web search and project instructions are disabled. The actor works in an empty directory and cannot reset the round. It is instructed to use only the game tools; the event audit checks for other tool use.

The runner saves the exact command, prompt, CLI version, seed, upstream revision, JSONL model events, usage, wall time, tool counts, final state and action trace. The final scene comes from the game, independently of the agent's written claim. This is an exploratory usability trial; a successful run alone does not establish an advantage over vision.

Replay every recorded action and compare the resulting scene hashes, using the same adapter version and settings as the recorded run:

```sh
npm run replay -- --trace artifacts/trials/terra-high-42/game/trace.jsonl --screenshot artifacts/replayed.png
```

## Verification

```sh
npm run typecheck
npm test
npm run build
npm run format:check
```

Tests exercise the actual game in Chromium: frozen observations, visible-only state, timed collisions, atomic invalid/stale actions, moving targets, curved combos, classic failures, seeded spawns, real bombs and MCP schema/capability boundaries. Run `npm run setup` before tests; the suite deliberately requires its real game dependency.

## Game provenance

The visual game is [fruit-ninja-dojo](https://github.com/yongqixue99-hue/fruit-ninja-dojo), pinned to commit `63d0af1906181cceb9486ed85cc2b65ce6e6ba0d`. `npm run setup` downloads its self-contained HTML into ignored `.local/game/` and verifies SHA-256 `6e072f6efc0f2bb69c98dede80ed524deda20f0004d27b7beb2e80f5c4ddf96f`. No game download occurs during an MCP session. The adapter verifies the same hash on every launch, then instruments the game in memory; unexpected integration anchors fail closed.

Upstream game art/source is not vendored or relicensed here. The upstream repository currently has no explicit license file; this private prototype keeps it as a separately fetched dependency. Confirm permission or replace that dependency before redistributing the game. This is a browser remake, not the official Halfbrick game.
