# Fruit Ninja: GUI vs agent-built MCP

Infrastructure for comparing a **screenshot-only GUI** player with a player that uses an **MCP
server built by an agent** that explored the game as a black box. Both play the same pinned,
realtime browser game under the same clock, scoring and native-mouse executor.

This branch (`feat/self-built-mcp`) is **Phase 0** of [the plan](docs/plan_p0.md): rebuilt
infrastructure, validated with a developer-only fixture MCP and scripted mock models. No model
has built an MCP here, and no benchmark score has been measured. It builds on `main` of
[N0zoM1z0/fruit-ninja-mcp](https://github.com/N0zoM1z0/fruit-ninja-mcp) (see
[NOTICE](NOTICE.md)) and keeps its game integration, GUI interface, scoring, telemetry and
video pipeline. The earlier prebuilt-MCP experiment is preserved as an evaluator-only reference
([legacy README](docs/LEGACY-README.md)).

## How it fits together

```
 builder LLM ──tools──► builder controller (host) ──docker exec──► builder sandbox (offline)
                         build: freeze by SHA-256                    packaged game, Chromium,
                         smoke: fresh play sandbox                   fn-inspect, fn-port
                         handoff ─────────────► frozen mcp/
 player LLM ──tools──► evaluator ──stdio──► play sandbox (offline): frozen mcp/ only
                         │                     └── unix socket ──► game port
                         │                                         adapter calls + native input
                         └── refereed game (Chromium, host only): referee via private CDP handle
 GUI player ──tools──► same game: get_controls / get_screenshot / click / drag
```

- **Packaged game:** the pinned upstream HTML plus public evaluation rules. These are a
  wall-clock physics pump, seeded spawns and trusted-input-only gameplay, with mode, motion
  and geometry locked once prepared, and a no-network, no-eval CSP. This is all the builder
  receives.
- **Refereed game:** the same build plus a private referee inside the game closure. It is
  captured into an evaluator-held handle and removed from `window` before any agent code
  runs.
- **Hardening:** after preparing the round, the host removes host hooks and scripts. It
  freezes JavaScript and DOM built-ins (Canvas 2D stays wrappable for observation), then
  injects the agent's frozen adapter.
- **Game port:** the generated MCP's only channel. It offers adapter calls (JSON, no pixels)
  and the GUI's executor, with at most one native input per player tool call.

Details, controls and known gaps: [ARCHITECTURE.md](ARCHITECTURE.md). Verified results for
commit `b5482c2`: [docs/PHASE0-EVIDENCE.md](docs/PHASE0-EVIDENCE.md). Independent review notes:
[docs/reviews/2026-11-07-phase0-independent-audit.md](docs/reviews/2026-11-07-phase0-independent-audit.md). The builder-visible
contract is [sandbox/public/CONTRACT.md](sandbox/public/CONTRACT.md), and the port API is
[PORT.md](sandbox/public/PORT.md).

## Setup and one-command checks

The host needs Docker and git. Everything else runs in project-labelled containers (Node 22,
Debian Chromium and ffmpeg, pinned base images). Setup downloads the game and verifies it by
SHA-256; game bytes are never committed.

```sh
make setup      # evaluator image, npm ci, game download, build, packaged game + image scan
make images     # builder and play sandbox images from scanned minimal contexts
make check      # typecheck and format check
make test       # full suite: unit, browser, sandbox and end-to-end pipeline
make preview    # scripted builder → fixture handoff → MCP play → GUI play → MP4 videos
make all        # all of the above
```

`make preview ARGS="--duration 10 --output artifacts/preview-1"` writes `summary.json`, full
traces and `mcp/game/game.mp4` and `gui/game/game.mp4`, original-speed and uncut. Remove
leftover containers with `make clean-containers`; it only touches this project's labels.

## Runners

All three runners use any OpenAI-compatible chat-completions endpoint (local or remote).
Keys are read from the environment variable you name and never enter sandboxes or traces.
`--mock NAME` selects a developer mock instead, which performs no inference.

```sh
# Builder: explore the packaged game and hand off an MCP (Phase 1 runs real models).
npm run builder -- --llm-base-url http://127.0.0.1:8080/v1 --llm-model MODEL --output artifacts/build-1
# GUI play and generated-MCP play of the same seed and duration.
npm run play -- --interface gui --llm-base-url URL --llm-model MODEL --llm-api-key-env KEY_VAR --seed 42 --duration 60
npm run play -- --interface mcp --handoff artifacts/build-1/handoff.json --llm-base-url URL --llm-model MODEL --seed 42 --duration 60
# Export a recorded run.
npm run export:video -- --trial artifacts/play/RUN
```

Run these inside the evaluator container (`make shell`). Each run directory holds:

- `provenance.json`: commit, image IDs, game hashes, endpoint (no key)
- `actor/` (or the builder run root): `prompt.json`, `llm.jsonl` (requests and responses) and
  `tools.jsonl` (every call with timing and result)
- `port.jsonl`, `mcp-stdio.jsonl` and `mcp-stderr.log` (MCP play)
- `game/`: telemetry, native input samples, frames and video
- `events.json` and `result.json`: score, clock audit, integrity and failure reasons

## Code layout

| Path                              | Visibility              | Responsibility                                                                       |
| --------------------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `src/public/`                     | shipped to sandboxes    | executor, lockdown, game port and client, dev game, `fn-*` helpers                   |
| `src/upstream.ts`                 | private (output public) | pinned game, public rules patch, packaged build                                      |
| `src/evaluator/`                  | private                 | referee, sandboxes, builder controller, freeze, smoke, policy, LLM loop, play runner |
| `src/runtime.ts`, `src/server.ts` | private                 | refereed game runtime; GUI tools and legacy reference MCP                            |
| `sandbox/`                        | images and public docs  | Dockerfiles, toolchain lockfile, CONTRACT, PORT, NOTICE                              |
| `dev-fixtures/`                   | developer only          | fixture MCP variants and scripted mock actors; never in images                       |
| `tests/`                          | private                 | unit, boundary, port, sandbox and pipeline tests                                     |
