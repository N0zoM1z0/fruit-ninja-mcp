# Results

The current implementation runs **realtime MCP versus screenshot-only GUI** under [REALTIME-PROTOCOL.md](REALTIME-PROTOCOL.md). Historical decision-clock scores are separate and are not evidence for realtime play.

## Realtime baseline: seed 42, 60-second arcade

[Machine-readable result](results/realtime-baseline-seed42-v1.json), source `7043319`, local Codex CLI 0.165.0, `gpt-6.1-terra` / `high`. One sequential attempt per interface with matching source, instrumented game, seed, viewport, speed, scoring and native input executor.

| Interface                             | Score | Sliced | Escaped | Spawned | Bomb hits | Max combo | Calls | Errors | Actual round wall time |
| ------------------------------------- | ----: | -----: | ------: | ------: | --------: | --------: | ----: | -----: | ---------------------: |
| MCP state + actor-authored paths      |    71 |     33 |     148 |     184 |         0 |         6 |    21 |      0 |              60.0068 s |
| Screenshot GUI + actor-authored paths |     7 |      4 |     150 |     158 |         0 |         3 |    15 |      1 |              60.0038 s |

Both clock audits passed. Maximum independent telemetry clock drift was 16.366 ms for MCP and 8.028 ms for GUI; model thinking and screenshots did not stop time. Both interface audits passed. GUI had one input rejected after the natural deadline. No actor reset, pause, future state or hidden targeting policy was used. End-to-end actor/runtime time was 77.232 s and 86.691 s respectively, including pre-start setup and post-round reporting; it is not the round duration.

Spawn counts differ because normal arcade frenzy changes wave frequency after successful slicing. The same seeded game and rules were used; the game was not forced to follow a fixed spawn transcript after different actions. Fruit still airborne at the deadline are counted as spawned but neither sliced nor escaped.

This run shows a useful difference in this setting, not a stable success rate or general speedup. Many fruit were missed in both arms. The trace also exposes substantial native-input scheduling overhead: some requested 180 ms MCP strokes took about 800 ms. This baseline is preserved before optimizing the shared executor; any revised executor will be tested in both arms with the same game speed and rules.

## Adaptive input and recorded realtime pair

[Machine-readable result](results/realtime-optimized-recorded-seed42-v2.json), source `691851d`, same model, reasoning, seed and 60-second game. Both arms recorded video. The shared input scheduler now skips obsolete interior samples, preserves every commanded corner, enforces the speed limit and buffers per-sample logging until mouse-up. Canvas geometry is cached for the fixed viewport; acceptance and result reads use fewer browser round trips. There is still no target selection, tracking or replanning in the executor.

| Interface      | Score | Sliced | Escaped | Spawned | Bomb hits | Calls | Errors | Actual round wall time |
| -------------- | ----: | -----: | ------: | ------: | --------: | ----: | -----: | ---------------------: |
| MCP            |    29 |     19 |     136 |     158 |         0 |    27 |      1 |              60.0072 s |
| Screenshot GUI |    11 |      8 |     146 |     158 |         0 |    15 |      0 |              60.0056 s |

Both interface and clock audits passed. Maximum independent telemetry clock drift was 72.545 ms for MCP and 19.884 ms for GUI. MCP had one input rejected after the natural deadline. The original-speed, uncut recordings retain setup, the entire round, missed fruit, idle inference periods and final result. See [recordings](recordings/seed42-v2/README.md).

Post-run audit corrected the original runner's error counts: Codex 0.165 omitted `isError` for these plain-text MCP error results. The summaries retain the original count and correction; raw artifacts, scores and recordings are unchanged. A regression test covers this representation.

An independent [vision transport check](results/vision-contract.json) used the same GUI screenshot endpoint and Terra/high. The actor correctly transcribed a fresh random 8-character code visible only in the image, with the code absent from its text prompt.

| Shared native input measurement        | Initial baseline MCP / GUI | Adaptive recorded MCP / GUI |
| -------------------------------------- | -------------------------- | --------------------------- |
| Median requested path duration         | 160 / 190 ms               | 150 / 150 ms                |
| Median actual path duration            | 682 / 416 ms               | 197 / 197 ms                |
| Median actual/requested duration ratio | 4.388 / 2.250              | 1.324 / 1.305               |

A separate recording-enabled fixed-path probe measured 100 ms requests at 145–146 ms, 180 ms at 213–224 ms, and 300 ms at 331–334 ms. Eight tests passed, including a deterministic slow-acknowledgement regression that preserves corners without replaying stale samples and the CLI error-audit regression.

**Lower input latency did not produce a higher MCP game score in this single recorded attempt.** The earlier 71-point run remains unchanged. The new run used different model decisions and enabled video capture in both arms, so score differences across iterations do not isolate the effect of the scheduler. The measured input timing improved; further game-policy work and repeated seeds would be needed to assess scoring reliability. No repeated takes were used to select a higher-scoring recording.

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

## Reproduce the historical decision-clock prototype

```sh
git checkout decision-prototype-v0.1.0
npm ci
npm run setup
npm run build
npm run trial -- --duration 20 --seed 2026 --output artifacts/trials/terra-high-2026-new
npm run replay -- --trace artifacts/trials/terra-high-2026-new/game/trace.jsonl --screenshot artifacts/trials/terra-high-2026-new/replayed.png
```

A new model attempt may choose different actions and earn a different score. Replay determinism applies to a fixed recorded action sequence.

## Verification and interpretation

The implementation passed typechecking, build, formatting, **12 real-game Chromium tests**, an independent stdio MCP discovery/start/screenshot check, and both action-trace replays. Tests include real bomb penalties, immediate classic bomb termination, three-miss termination, multi-fruit combos, moving targets, hidden-state filtering and atomic rejection of stale/invalid paths.

These historical decision-clock runs established prototype usability only. They did not include a vision comparison and do not support realtime performance claims. Use the separate realtime measurements above for the current interface comparison.
