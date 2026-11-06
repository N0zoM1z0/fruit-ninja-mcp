# Results

The current implementation targets **realtime MCP versus screenshot-only GUI** under [REALTIME-PROTOCOL.md](REALTIME-PROTOCOL.md). The paired realtime baseline will be recorded separately below. None of the historical scores in this file establish realtime play or an advantage over GUI.

## Historical decision-clock trials (not realtime)

Two exploratory MCP-only playthroughs ran on 6 November 2026 with the installed **Codex CLI 0.165.0**, **gpt-6.1-terra**, and **high** reasoning effort. Both completed an arcade round through the assigned MCP tools. The game, rather than the model's final answer, supplied the scores below.

| Run                                                     | Adapter                | Seed | Game time | Score | Sliced / spawned | Escaped | Bomb hits | Max combo | Tool calls | Tool errors | Wall time | Replayed actions |
| ------------------------------------------------------- | ---------------------- | ---: | --------: | ----: | ---------------: | ------: | --------: | --------: | ---------: | ----------: | --------: | ---------------: |
| [Initial smoke](results/terra-high-seed42-v1.json)      | Before final clock fix |   42 |  20.008 s |   360 |        100 / 100 |       0 |         0 |         5 |         73 |           0 | 197.729 s |               72 |
| [Current baseline](results/terra-high-seed2026-v2.json) | `1321157`              | 2026 |  20.000 s |   300 |          85 / 85 |       0 |         0 |         5 |         68 |           0 | 180.873 s |               67 |

The clock is **decision-step**, not real time: thinking and observation freeze the world, while timed blade paths and waits advance it. The first run retained upstream floating-point clock accumulation and ended one 120 Hz physics tick late. The final adapter derives round time from integer ticks; the second run tests that version. The original first-run scores and timings have not been rewritten.

Each trace replay matched every recorded scene hash. The first replay was performed before the timer fix; it is historical evidence, not a replay fixture for the current adapter. The current baseline includes runtime JavaScript fingerprints and an instrumented-game hash; those matched the tested build at verification time. Reproduce a trace with the same adapter version, upstream pin, viewport and settings.

Both event audits found no calls outside `fruit_ninja`, no model shell/file/web actions, and no tool errors. Locked trial sessions omitted `new_game`, so the actor could not reset an unfavorable round. Arcade frenzy can remove bombs and increase fruit frequency under the original game rules; zero bomb hits does not mean every run required a close avoidance maneuver.

Raw prompts, CLI events, exact arguments, usage counters, final state, screenshots and game traces remain under the ignored local `artifacts/trials/` directories named in each JSON summary. Aggregated input-token counts in the CLI telemetry include repeated cached context; cached counts are recorded separately. No cost estimate has been inferred.

## Reproduce the current baseline

```sh
npm ci
npm run setup
npm run build
npm run trial -- --duration 20 --seed 2026 --output artifacts/trials/terra-high-2026-new
npm run replay -- --trace artifacts/trials/terra-high-2026-new/game/trace.jsonl --screenshot artifacts/trials/terra-high-2026-new/replayed.png
```

A new model attempt may choose different actions and earn a different score. Replay determinism applies to a fixed recorded action sequence.

## Verification and interpretation

The implementation passed typechecking, build, formatting, **12 real-game Chromium tests**, an independent stdio MCP discovery/start/screenshot check, and both action-trace replays. Tests include real bomb penalties, immediate classic bomb termination, three-miss termination, multi-fruit combos, moving targets, hidden-state filtering and atomic rejection of stale/invalid paths.

These runs establish a useful MCP interface: an LLM can use object state and bounded timed paths to complete a game with sustained combos. **There is no pure-vision comparison yet**, so these observations do not establish an MCP speedup, token reduction, win-rate advantage, or general reliability claim. A vision comparison should keep the game, seed, model, clock, action limits and scoring consistent and use screenshot-only observations.
