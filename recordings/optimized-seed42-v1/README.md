# Optimized realtime MCP recording

[Watch the complete MP4](mcp.mp4): one 60-second realtime arcade game, original speed, uncut. The 81.48-second capture includes setup, the full round and the result screen.

| Score | Sliced | Escaped | Spawned | Bomb hits | Max combo | Actual round wall time |
| ----: | -----: | ------: | ------: | --------: | --------: | ---------------------: |
|   189 |     71 |     136 |     219 |         0 |         9 |               60.0038s |

This is the first recorded take of the selected optimized configuration: local Codex CLI 0.165.0, `gpt-6.1-terra` / `high`, coverage guidance, `async` execution, `compact` feedback, seed 42. Source `05cd84d` matches the recorded source fingerprints. The seed matches the earlier recordings and was chosen before this attempt; no repeated takes or score-based selection were used.

Every path is authored by the actor and executed through native browser mouse events under the same 1000ms / 32-point / 5000px/s limits. Planning can overlap the single executing path. The game continues throughout inference, observations and input. No pause, hidden aiming, future-spawn information, time scaling or footage trimming was used.

Both interface and independent clock audits passed. Maximum telemetry clock drift was 10.346ms. One input was rejected after the natural round deadline (`ROUND_NOT_PLAYING`); the error and the unchanged result are retained. Fruit still airborne at the deadline are neither sliced nor escaped.

The H.264 MP4 is 1440×960 at 25fps. All 2,037 decoded source frames and packets were retained, with source and export durations both 81.48 seconds. No gameplay frames were replaced. The original WebM, screenshots, native input samples, independent clock telemetry, prompt and CLI events remain in local `artifacts/recordings/optimized-mcp-seed42-v1/`.

- [Scores, settings and source fingerprints](../../results/optimized-mcp-recorded-seed42-v1.json)
- [Export manifest and SHA-256 hashes](mcp.export.json)
- [Source/export frame validation](mcp.validation.json)
- [Optimization evidence](../../OPTIMIZATION.md)
- [Realtime protocol](../../REALTIME-PROTOCOL.md)

This MCP-only recording is not a new paired comparison. See the separate held-out validation for matched MCP/GUI results. The private repository includes this MP4 for review; upstream game source and art have not been vendored or relicensed.
