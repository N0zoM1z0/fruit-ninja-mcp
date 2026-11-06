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
