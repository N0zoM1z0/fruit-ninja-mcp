# Fruit Ninja — Phase 0: Rebuild the Black-Box Infrastructure

**Goal:** Start a new private repository based on `N0zoM1z0/fruit-ninja-mcp`. Keep its working browser game, GUI baseline, evaluation, and video recording. Replace the prebuilt-MCP experiment with infrastructure for **GUI vs. agent-built MCP**. The previous Orchard Blade repository has been deleted; do not depend on it.

## Work

1. **Preserve the game.** Pin the upstream version and assets; verify normal gameplay, real-time clock, mouse slicing, scoring, and MP4 capture. Keep GUI actions screenshot-and-mouse only.
2. **Separate trust boundaries.** Make the packaged browser game the builder's black-box target. The builder may inspect software shipped to a user (including browser-delivered JS), but must not see repository internals, the prebuilt MCP/bridge implementation, referee state, seeds, credentials, or hidden evaluation tools. Keep reference instrumentation private to evaluation and inaccessible in the agent's play-time environment.
3. **Build the self-MCP workflow.** Adapt the useful builder, REA, sandbox, freeze, load, and validation ideas from `/Users/saionjitoko0822/Documents/GitHub/REA_project/rea_tool/mcps-reef-rea`. Choose tools appropriate to a browser/JS target; do not force native-binary mechanisms. The agent should eventually be able to explore, write, test, and hand off its own MCP, with no supplied gameplay MCP.
4. **Wire the runners.** Support builder, GUI-play, and generated-MCP-play through configurable local/OpenAI-compatible LLM endpoints. Ensure both play modes use the same pinned game, time rules, and legal inputs. Record prompts, tool traces, errors, timings, scores, and provenance. Keep the existing video/export path usable.
5. **Validate infrastructure.** Use a *developer-only* fixture MCP and scripted/mock models to prove the end-to-end path. Test that a legal tool changes the live game and that no-op, GUI-wrapper, and privileged-state shortcuts do not count as success. Do **not** require an LLM to discover or build a successful MCP in Phase 0.
6. **Release.** Create a **new private GitHub repository**, push a reproducible clean checkout, and stage/test on the configured `ssh reef` host without disturbing other projects. Document setup and one-command smoke/video preview. Check upstream redistribution terms before copying game assets into the new repository.

## Acceptance

- Fresh checkout can install/build, run the game, perform a real GUI swipe, capture a short playable video, and produce a score.
- Sandbox can inspect the packaged game while protected code/data stay isolated; at least one appropriate analysis operation works.
- A test-only MCP can be loaded and make an observable legal gameplay call; negative controls fail for the right reasons.
- GUI and dynamically loaded MCP runners work with mock/tool calls, traces, and the existing evaluation clock. Model-backed autonomous building and score comparisons are **Phase 1**.
- Private repository and `reef` staging are working; evidence identifies commit and commands.

**Working style:** Reuse proven components; redesign only where the trust boundary demands it. Debug with focused tests and a specific hypothesis. Run a full suite after meaningful changes, then stop once acceptance is met. Never repeat unchanged tests, launch autonomous-builder campaigns, spend paid API credit, or perform global Docker cleanup. Report genuine blockers without treating routine test bugs as reasons to abandon the task.
