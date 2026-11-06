# Realtime MCP optimization

Keep the original game speed, 60-second arcade duration, Terra/high model, native mouse executor, 1000ms path limit, collision rules and independent clock audit. No recording is enabled in this series. No server-side target choice, automatic path planning, future-spawn access or score changes.

## Diagnosis

In the recorded seed-42 MCP attempt, 19 executed paths consumed 3.763 seconds in total. Their requested median duration was 150ms. Estimated observation age at action acceptance had a median of 2.314 seconds, while visible fruit had an estimated median remaining visible lifetime of 1.336 seconds. These are reconstructed from recorded observations, input timestamps and public kinematics, not a direct model-thinking measurement.

The main hypotheses are that observation timing and intentional action coverage matter more than shaving a few further milliseconds from native input.

## Staged experiments

1. **Coverage guidance only:** preserve tools and feedback, encourage the actor to author deliberate 600–900ms bounded paths and reach 20 fruit early. The same guidance is available to the GUI arm when compared. The server still chooses no coordinates.
2. **Fresh observations:** wait in real time for newly visible fruit and return immediately at entry, with visible lifetime/phase information. Never return objects that are still outside the viewport. Evaluate separately before combining.
3. **Compact feedback:** retain decision-relevant objects, timing and score; keep full audit state in independent artifacts. Measure actual call timing rather than assuming smaller responses improve latency.
4. **Overlap if justified:** permit a bounded actor-authored action to execute while planning continues, with explicit pending-action state and no backend replanning. Introduce only after the simpler variants are measured.

Use seed 42 for development. Record every attempt and preserve lower scores and errors. Before claiming an improvement, compare the selected configuration with baseline on seeds **2026 and 7**, chosen before tuning. Rerun GUI with the selected common guidance and unchanged shared action limits. Report score, sliced/escaped fruit, action coverage, effective observation age, tool errors and clock validity. A small sample selects a practical configuration; it does not establish a global optimum or a stable win rate.

## Development observations

| Policy   | Profile  | Feedback | Score | Sliced | Bombs | Native execution / 60s |
| -------- | -------- | -------- | ----: | -----: | ----: | ---------------------: |
| Baseline | Standard | Full     |    27 |     17 |     0 |                   4.6% |
| Coverage | Standard | Full     |    86 |     39 |     1 |                  21.5% |
| Baseline | Fresh    | Full     |     3 |      3 |     0 |                   5.8% |
| Coverage | Fresh    | Full     |    16 |     13 |     0 |                  15.1% |
| Coverage | Standard | Compact  |    78 |     35 |     0 |                  18.2% |
| Coverage | Async    | Full     |   130 |     55 |     0 |                  27.9% |
| Coverage | Async    | Compact  |   137 |     57 |     0 |                  28.4% |

These are single development attempts, not replicated estimates. All completed naturally with valid independent clocks. Full provenance and errors are retained in `results/mcp-optimization.json`. Waiting for fresh entry did not help this actor: observation-to-next-request delay still exceeded fruit lifetime. Compact feedback performed close to full feedback, without evidence of a score improvement yet.

## Asynchronous execution contract

The optional `async` profile replaces `swipe` with `submit_swipe`, and GUI `drag` with `submit_drag`. Each request accepts one actor-authored path under the same 1000ms, 32-point, 5000px/s limits. It acknowledges after validation and before native execution finishes, so inference can overlap that execution. A busy request accepts no new action and queues nothing. No action repeats, chooses targets, extends itself, or changes its coordinates after submission. Mouse-up still ends every accepted path.

MCP acknowledgements include the current visible scene and generic execution status. GUI acknowledgements include a current screenshot and generic execution status only; they never contain score, objects, events, coordinates extracted from the game, or other dynamic application state. Observations can occur during execution. Full native input, outcomes and wall-time telemetry remain independent of the actor. The two interfaces have identical execution capabilities.

## Selection before held-out validation

Select **coverage + async + compact** for validation on seeds 2026 and 7, against baseline + standard + full. The same coverage guidance and asynchronous executor are provided to the GUI arm. The 137-point development attempt slightly exceeds async/full at 130; that seven-point difference does not establish a reliable advantage of compact feedback. Selection uses only development seed 42; do not tune the selected configuration after seeing held-out results. The previous 71-point realtime baseline and lower-scoring variants remain unchanged.
