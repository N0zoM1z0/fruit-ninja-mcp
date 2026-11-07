# Phase 1 pilot: GUI vs self-built MCP (DeepSeek V4.1 Flash)

One end-to-end pilot, run once: a real builder session, then one 60-second round per interface.
It is a single observation per condition on one seed, not a benchmark.

- **Code:** `4d7fde35f3488c96c167afd6f4401a4c2d924028` (clean checkout, `dirty: false`).
- **Host:** `reef:~/fruit-ninja-mcp-phase1/4d7fde3`, 2026-11-07 03:49:41–04:22:17 UTC
  (32 min 36 s).
- **Command:** `make pilot ARGS="--llm-config config/deepseek-v4.1-flash.json --builder-max-tokens 32768 --output artifacts/phase1/pilot-1"`,
  exit 0.
- **Pre-run check at the same commit:** `make setup images check test` passed. The image scans
  were clean and 46/46 tests passed.

## Model and settings

| Setting      | Value                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model        | `deepseek-ai/DeepSeek-V4.1-Flash` (OpenAI-compatible endpoint in [config](../config/deepseek-v4.1-flash.json))                                     |
| Sampling     | temperature 0.3, top_p 0.9, `reasoning_effort: high`, no streaming                                                                                 |
| `max_tokens` | 2048 for both players. **32768 for the builder only:** it writes whole source files as tool-call arguments. No builder reply reached either limit. |
| Credential   | `DEEPSEEK_API_KEY`, passed to the evaluator container by name only. A scan found it in no artifact, log or checkout.                               |
| Game         | arcade, seed 42, 60 s, the same refereed build, clock, executor and rules for both players                                                         |

## Builder

The builder was given only the packaged game, the contract and the controller tools. It had no
gameplay MCP and no developer fixture. It worked in this order:

1. Explored the game: shell, `inspect_js`, its own probe adapters and port client against
   `fn-port`.
2. Implemented the MCP: a Node stdio server, `mcp/server.js`, and an in-page adapter,
   `mcp/adapter.js`.
3. Tested it, and froze four versions; each passed smoke.
4. Handed off the last version, `c34c30da…5b46`, at turn 146.

The adapter reconstructs fruit and bombs by wrapping Canvas 2D rendering calls (`drawImage`,
`fillRect`, `save`, `restore`, `clip`, `clearRect`) and reads the HUD from the DOM. The MCP's
tools are listed below.

| Tool          | Manifest mechanism                                |
| ------------- | ------------------------------------------------- |
| `game_state`  | adapter observation; no input                     |
| `start_round` | one native click on the start button              |
| `slice`       | in-page trajectory planning, then one native path |
| `slice_fruit` | the same planning for a given fruit id            |

| Builder metric                         | Value                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------ |
| Turns / controller calls / tool errors | 146 / 160 / 1 (a `write_file` outside `/output`)                         |
| Wall time                              | 29.2 min, with a budget of 200 turns and 3 h                             |
| Tokens                                 | 23,304,808 prompt (99.3 % cached), 161,012 completion, 113,968 reasoning |
| LLM latency                            | median 1.19 s, p90 11.0 s, max 81.4 s                                    |
| Finish reasons                         | 146 × `tool_calls`; no truncations; no compaction triggered              |

## Comparison (same model, seed, duration and rules)

| Metric                                         |                                                Self-built MCP |                                                                           GUI |
| ---------------------------------------------- | ------------------------------------------------------------: | ----------------------------------------------------------------------------: |
| **Score**                                      |                                                      **1268** |                                                                        **28** |
| Sliced / spawned / escaped fruit               |                                                 328 / 346 / 8 |                                                                18 / 158 / 136 |
| Bombs hit / max combo                          |                                                        0 / 12 |                                                                         0 / 4 |
| Legal native paths (+ start click)             |                                                       50 (+1) |                                                                       18 (+1) |
| Actor tool calls                               |            53: `slice` ×50, `game_state` ×2, `start_round` ×1 |            25: `drag` ×19, `get_screenshot` ×4, `click` ×1, `get_controls` ×1 |
| Actor tool errors                              |                                                             0 |                                              1 (a drag after the round ended) |
| LLM turns / latency median / p90               |                                          54 / 0.37 s / 0.57 s |                                                          25 / 1.62 s / 2.50 s |
| Tokens                                         | 297,814 prompt (92 % cached), 2,601 completion, 928 reasoning | 161,058 prompt (54 % cached, 39,010 image), 6,502 completion, 3,574 reasoning |
| Validity                                       |                   `valid_gameplay`, clock valid (drift 39 ms) |                                   `valid_gameplay`, clock valid (drift 94 ms) |
| Integrity                                      |   no violations; 328/328 slices attributed; 0 port rejections |                                        no violations; 18/18 slices attributed |
| Video (original speed, uncut, all frames kept) |                                       66.0 s, `68a41d76…9b35` |                                                       69.2 s, `8cb9506c…adc9` |

Before playback, the handoff replay was verified against the passing smoke and the frozen
inventory digest. The play-time interface policy accepted the MCP's tools; no image results
were relayed and no input was outside the one-per-call budget.

## Interpretation and limitations

- **What the gap measures.** The MCP's own `slice` tool selects targets and plans each stroke
  in the page. The player model mostly called `slice` repeatedly. The difference therefore
  reflects the builder-written observation **and automation**, against a GUI model that aims
  every drag from screenshots. The contract allows this, since each call makes one native
  input, but the earlier review noted that planning inside an MCP is not semantically
  restricted. Whether such automation should count needs an explicit rule before a benchmark.
- **n = 1.** One builder run and one round per condition on seed 42. There are no confidence
  intervals and no claim beyond this pilot.
- **Spawn counts diverge with play.** Arcade frenzy after every 20 slices changes later
  spawning, so the same seed produced 346 versus 158 fruit.
- **GUI loop cost.** Each GUI step includes a screenshot capture of about 0.8 s on reef plus
  1.6 s of model latency, which allowed 19 drags in 60 s.
- **Builder `max_tokens` deviation.** This is the one change from the supplied settings. With
  no truncations observed, it is unknown whether 2048 would have sufficed.
- **Acceptance.** Model-run hidden functional probes are still not implemented. The
  acceptance gates are smoke, the interface policy, handoff verification and the play audit.
- **Cost.** Token usage is as reported by the endpoint; prices are not known here.

## Artifacts

- **Committed** ([evidence/phase1/pilot-1/](../evidence/phase1/pilot-1/)): `summary.json`,
  builder handoff, builder result and prompt, per-run `result.json`, `events.json`,
  `provenance.json`, prompts, video export records, and the frozen handoff itself. The
  handoff was re-verified with `verifyFrozen` as `c34c30da…`.
- **Not committed** (the game is unlicensed; see [NOTICE](../NOTICE.md)):
  - Full traces: `llm.jsonl` (builder 75 MB), `tools.jsonl`, port and stdio logs.
  - Telemetry, frames, and the WebM and MP4 recordings.

  They are kept at `reef:~/fruit-ninja-mcp-phase1/4d7fde3/artifacts/phase1/pilot-1/` and
  mirrored into the workspace's ignored `artifacts/phase1/pilot-1/`.
