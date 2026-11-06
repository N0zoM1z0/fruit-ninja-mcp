# Realtime recorded games

Two original-speed, **uncut** captures of one 60-second arcade round per interface. Each file includes setup before the start and the final result after the game. No gameplay frames were trimmed, time-scaled or replaced. The model keeps thinking while the fruit continue moving.

| Recording                                               | Final score | Sliced | Escaped | Actual game wall time | Capture length |
| ------------------------------------------------------- | ----------: | -----: | ------: | --------------------: | -------------: |
| [MCP state and actor-authored paths](mcp.mp4)           |          29 |     19 |     136 |             60.0072 s |        80.12 s |
| [Screenshot-only GUI and actor-authored paths](gui.mp4) |          11 |      8 |     146 |             60.0056 s |        93.84 s |

Local Codex CLI 0.165.0, `gpt-6.1-terra`, `high`; seed 42, identical game speed and shared adaptive native mouse executor. Source `691851d`. The GUI actor receives only images for dynamic observations. An independent [vision transport check](../../results/vision-contract.json) confirms that the model can read a random code delivered through that screenshot endpoint.

These are the first recorded takes under this configuration. The earlier, unrecorded realtime baseline scored 71 for MCP and 7 for GUI and remains preserved. Faster, more accurate input execution did not yield a higher MCP score in this single recorded attempt. The comparison is exploratory, not a stable performance estimate.

Both clock and interface audits passed. MCP had one late input rejected after the game ended; GUI had none in this pair. The original runner omitted the rejection flag in its count; the corrected summary records it. No score or footage was changed by the audit correction.

Each H.264 MP4 is 1440×960 at 25 fps. Conversion retained all 2,003 source frames for MCP and all 2,346 for GUI, with equal source/export durations. Export manifests contain SHA-256 hashes, original source locations and exact FFmpeg arguments:

- [MCP export](mcp.export.json) and [frame validation](mcp.validation.json)
- [GUI export](gui.export.json) and [frame validation](gui.validation.json)
- [Scores, timing, usage and runtime fingerprints](../../results/realtime-optimized-recorded-seed42-v2.json)
- [Protocol](../../REALTIME-PROTOCOL.md)

Uncut original WebM, screenshots, native input samples, independent clock telemetry, prompts and CLI events remain in local `artifacts/comparisons/realtime-optimized-recorded-seed42-v2/`. The private repository contains these MP4 exports for convenient review; the upstream game has not been vendored or relicensed.
