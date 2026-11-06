# Realtime MCP versus screenshot GUI

## Objective and historical boundary

Compare application-specific MCP observations with screenshot-only GUI control in a continuously running Fruit Ninja game, using local Codex CLI, `gpt-6.1-terra`, and `high` reasoning effort. Preserve unsuccessful attempts and report scores before optimizing. An MCP win is not assumed.

The earlier decision-clock prototype and its scores are **not realtime evidence**. Its complete source is preserved at tag `decision-prototype-v0.1.0`; its historical JSON results remain unchanged.

## Common game and timing

- Use the same pinned upstream game, viewport, seeded spawn RNG, difficulty, physics, collision rules, scoring, rendering settings, and pointer executor in both arms.
- Default to one 60-second arcade round with seed 42 in each arm, run sequentially. Do not select seeds based on which arm wins.
- A round begins when the prepared game is explicitly started. Setup and reading controls may happen before the start. The GUI starts through an ordinary mouse click; MCP has a native start operation.
- After starting, the world follows monotonic wall time independently of inference, observations, input calls, screenshots, focus, or the model exiting early. Pause controls are disabled for both arms. No slow motion or camera shake is enabled in either arm.
- The clock uses 120 Hz physics ticks derived from wall time. Delayed callbacks catch up instead of dropping elapsed time. Record clock lag and actual wall duration; infrastructure problems remain visible.
- A timed path takes real wall time to execute. Use actual browser mouse events in both arms. The executor interpolates only the coordinates the actor supplies; it does not choose or track targets.
- When native acknowledgements are late, the shared scheduler may skip obsolete interior interpolation samples. It must emit every actor-supplied corner, enforce the speed limit, and record actual issuance/acknowledgement times. No event is backdated, and no simulation time is removed.
- A path has 2–32 points, lasts 16–1000 ms, and is limited to 5000 px/s in both arms. No future commands, repeated macros, target-ID slicing, homing, auto-aim or hidden controller policy.
- A locked trial permits one start and no reset, reseed, pause, or restart. If an actor stops early, the game continues to its natural end before grading.

## Interface boundary

**MCP:** current visible-object positions, velocities, collision radii, score and events; actor-authored timed canvas paths. No future spawns, RNG state, arbitrary code, source access or automatic path planning.

**GUI:** real screenshots, ordinary coordinate clicks and timed mouse drags in full-image pixels. Action results contain screenshots, with no object list, numeric game state, extracted text, OCR, DOM, selectors, accessibility tree, developer console or application-native commands. Static control instructions and game rules are available to both arms.

The GUI driver also uses MCP transport. The comparison concerns application-specific information versus pixels, not protocol serialization. Identical path expressiveness makes the initial comparison primarily an observation comparison.

The optional `async` profile acknowledges a single bounded path before it finishes, allowing the actor to plan during native execution. It provides this capability to both interfaces: `submit_swipe` for MCP and `submit_drag` for GUI. Every path retains the same limits. At most one executes, a busy request queues nothing, and no path repeats or replans. MCP may read current visible state during execution; GUI may capture current pixels. GUI acknowledgements can include generic input status (acceptance, action ID, pending/completed/failed status and input duration) but never dynamic game state or slice events. Record the profile and feedback format for every trial.

Optimization uses development seed 42 and held-out seeds 2026 and 7, fixed in [the experiment plan](OPTIMIZATION.md) before selecting a variant. Coverage guidance is supplied equally to MCP and GUI. Retain all variants and results, including those that reduce score.

## Evidence and reporting

Retain exact prompts and arguments, CLI/model settings, runtime and game hashes, native pointer events with wall timestamps, independent clock/state telemetry, screenshots, model tool events, errors, usage and final game scores. The evaluator can inspect state; GUI actors cannot.

Report score, sliced/spawned/escaped fruit, bomb hits, combos, observation/action counts, tool errors, wall duration and clock lag for both arms. A zero score is a valid outcome. Decision-clock results, model claims and failed infrastructure are not substitutes for realtime measurements.

First run the baseline without a built-in gameplay policy. Optimize only after preserving that result, identify what changed, and rerun both arms under the same updated conditions when the change affects the shared game or executor.
