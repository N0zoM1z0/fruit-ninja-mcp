# Phase 0 acceptance evidence

Verified commit: `b5482c2b2590a7b5cc8214bc3b4a235419b17ece` (clean checkout, `dirty: false`).
Host: `ssh reef` (Debian 13, Docker 29.1.3), fresh clone at
`~/fruit-ninja-self-mcp-p0/release-b5482c2`, 2026-11-06 17:52:41–17:56:20 UTC.
All results come from developer fixtures and scripted mock models. No LLM was called and no
benchmark score was measured.

```sh
git clone git@github.com:kaoru0822-kitauji/fruit-ninja-self-mcp.git release-b5482c2
cd release-b5482c2
make all ARGS="--output artifacts/preview-release --duration 10"   # exit 0, 3 min 39 s
```

| Stage     | Result                                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `setup`   | evaluator image; `npm ci`; pinned game downloaded and SHA-256 verified; build; packaged game `f51d160e…b024`                             |
| `images`  | builder `sha256:583fbc4b…65cc`, play `sha256:1058a21a…110d`, evaluator `sha256:5899361d…ac6a`; both context scans: 0 private-marker hits |
| `check`   | typecheck and Prettier pass                                                                                                              |
| `test`    | 40 tests, 40 pass, 0 fail (113 s)                                                                                                        |
| `preview` | exit 0; summary below                                                                                                                    |

Runtime: Node v22.23.4, Chromium 156.0.8078.79 (Debian bookworm package), base
`node:22-bookworm-slim@sha256:5ec23b7c…d96d`.

## Acceptance criteria

1. **Fresh checkout, real GUI swipe, video, score.** `make all` in a new clone. The scripted GUI
   actor clicked the start button and made 4 native drags in a 10 s round. Result: score 27, 14
   sliced, clock valid. Video: `gui/game/game.mp4`, 15.48 s, 387 frames, all source frames
   retained, SHA-256 `a1cc5ad2…2921`.
2. **Sandbox inspects the packaged game; protected material isolated.** `sandbox.test` covers:
   - uid 10001, no network, no secrets in the environment, target read-only;
   - `inspect_js symbols` finds the game's declarations;
   - the sandbox Chromium loads and screenshots the packaged game and sees no referee globals;
   - the dev port answers `/v1/info`;
   - both images scanned clean.
     The scripted builder's traced calls show `uid=10001`, `NETWORK_BLOCKED` and `inspect_js`
     output.
3. **Test-only MCP loads and makes a legal call; negative controls fail for the right reasons.**
   The scripted builder froze, smoked and handed off the developer fixture (`fe99702c…8561`,
   smoke pass). Generated-MCP play of that handoff loaded it dynamically and scored 29 with 23
   attributed slices over 28 legal paths, valid gameplay. Video: `mcp/game/game.mp4`, 13.64 s,
   341 frames, SHA-256 `90cf26d7…4875`. `pipeline.test` controls:
   - no-op: `ROUND_NOT_STARTED`, `NO_LEGAL_INPUT`, `NO_GAMEPLAY_EFFECT`;
   - GUI wrapper: smoke `interface:gui_primitive:{screenshot,click,drag}`; play refused with
     `INTERFACE_REJECTED`; when forced, `PIXELS_WITHHELD` at the port and `PIXELS_RELAYED`;
   - privileged:
     - no referee globals, routes (`NOT_FOUND`), files or secrets;
     - synthetic DOM events neither start nor slice;
     - built-in hooks blocked;
     - autopilot gets `accepted, INPUT_BUDGET_EXCEEDED, INPUT_BUDGET_EXCEEDED`;
     - CSS tampering gives `INTEGRITY_VIOLATION:canvas_rect_changed`.
4. **GUI and dynamically loaded MCP runners with mock calls, traces and the evaluation clock.**
   Both runs completed with a valid clock. Telemetry drift was 14.4 ms (MCP) and 125.5 ms (GUI;
   the limit is 150 ms, and screenshot capture delays telemetry sampling). Each run directory
   holds `provenance.json`, `actor/{prompt.json,llm.jsonl,tools.jsonl}`, `game/` telemetry,
   native input samples and video, plus `result.json`. MCP runs add `port.jsonl` and
   `mcp-stdio.jsonl`.
5. **Private repository and reef staging.** `kaoru0822-kitauji/fruit-ninja-self-mcp` (PRIVATE).
   Reef staging is under `~/fruit-ninja-self-mcp-p0/` (`dev/` development sync,
   `release-b5482c2/` verified clone). Images are tagged `fruit-ninja-self-mcp/*:b5482c2b2590`.
   Containers are labelled `fnsm.project=fruit-ninja-self-mcp`, and none remained afterwards.
   No other project's directories, images or containers were touched, and no global Docker
   cleanup was run.

Raw artifacts stay on reef under `release-b5482c2/artifacts/preview-release/`. They are not
committed, because the game has no license; see [NOTICE](../NOTICE.md).

## Remaining gaps (Phase 1 and later)

- No model-backed builder run, hidden functional acceptance probes or score comparison yet.
- Known boundary gaps are listed in [ARCHITECTURE.md](../ARCHITECTURE.md#known-gaps-accepted-for-phase-0).
  The main one is code generation inside host-initiated adapter calls.
- GUI telemetry drift sits close to the 150 ms validity limit on reef because 1440×960 PNG
  screenshots take about 0.8 s. Measure this before relying on GUI clock validity in long
  runs.
