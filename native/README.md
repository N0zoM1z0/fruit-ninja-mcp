# Windows Fruit Ninja: REA → MCP

This version runs the historical Windows **Fruit Ninja HD 1.6.1** executable
under Wine. REA/Ghidra recovered the active entity lists, object fields, motion
equations, score and clock. The MCP reads that native state and uses the browser
pilot's ballistic interception strategy to produce real mouse strokes.

The target executable is unchanged. The observation helper opens the process
with `PROCESS_VM_READ`; one bounded `snapshot` request reads both lists and
rechecks their descriptors before publishing bytes. Node decodes the REA layout
without per-entity pipe round trips. Torn snapshots are retried as a whole,
preserving bomb coverage. Game actions use X11 XTest through Wine's input stack.
The screenshot GUI interface uses the same executor, timing and speed limits.
Both use one persistent XTest worker, with interpolated input scheduled against
absolute time. Rendering is capped at 30 fps by default; recording uses two
encoder threads and one filter thread. Recordings contain only the game window,
without an observer panel.

## Run

Existing prerequisites: Wine with 32-bit support, Xvfb, xdotool, Python/Pillow,
7-Zip, FFmpeg, Node.js, Meson, Ninja, MinGW's i686 C/C++ compiler, Git and curl.
The renderer uses a working Vulkan driver, including Mesa's software driver.
Software rendering defaults to `LP_NUM_THREADS=4` to keep worker stacks within
the original 32-bit process's address space during result-screen allocation.

```bash
npm run windows:setup
npm run windows:demo
```

Setup downloads a hash-pinned historical archive and extracts its embedded CAB
without running its installer. It builds DXVK 2.4 with the upstream
[Fruit Ninja normal-matrix fix](https://github.com/doitsujin/dxvk/pull/5765)
backported for this Wine version. Dependencies and build outputs remain in
`.local/windows/`; the first renderer build takes several minutes.

The demo is a **scripted MCP client**, not an LLM benchmark. It connects
to a loopback MCP server, uses the common menu initializer and repeatedly calls
`slice` until the native result screen appears. Its output directory contains
`video.mp4`, a result PNG, advertised tools, every tool call, and `result.json`. The console
prints the directory. The recording is uncut and runs at the captured speed.
Native game seconds and wall-clock seconds can differ under software rendering;
the result records both native clock completion and elapsed wall time.

## Terra high: MCP versus GUI

```bash
npm run windows:compare -- --model gpt-6.1-terra --reasoning high --output .local/windows/comparisons/my-run
npm run windows:compose -- .local/windows/comparisons/my-run
python3 native/quality.py .local/windows/comparisons/my-run/mcp
python3 native/quality.py .local/windows/comparisons/my-run/gui
```

The comparison runs the configured Codex CLI as the actual player, sequentially
on both interfaces with the same model and reasoning settings. Each player gets
one real-time Arcade round. The first player tool call triggers the same common
menu initializer on either interface. Model startup occurs before the native
round starts; all subsequent thinking and tool calls consume real game time. It does not expose `start_round` during
evaluation. The evaluator owns the native clock and waits for settled bonuses
even if the player exits early. Input closes when the evaluated round ends.

Both individual videos contain only the original **1024 × 768 game window**.
Diagnostic state and planner telemetry stay in local logs, outside the recording
and GUI player interface. The **2048 × 768** side-by-side copy places MCP on the
left and GUI on the right. It aligns player handoff, retains original speed and
holds the shorter result as a still; individual videos retain menus and ending.

Outputs include `summary.json`, per-interface `result.json`, `metadata.json`,
`video.mp4`, `result.png`, player prompts/configuration, Codex events and the
observer event log. `quality.py` crops out the HUD before measuring
visible pixel updates; it does not equate 30-fps encoding with engine FPS.
Each session also saves the native implementation sources and SHA-256 manifest,
so later edits cannot silently change the recorded implementation.
The GUI report includes idle gameplay frames because GUI telemetry omits native
entities; its update count should not be directly compared with the MCP report's
native-motion-only windows.

The Windows target has no recovered seed-setting interface. These are separate
unseeded rounds and a single-pair demonstration. `slice` includes native sensing
and automatic planning, so the result measures observation **and automation**.
The actor's shell, web search and delegation are disabled; its tool trace is
checked against the assigned interface. Only the local game server is configured
for preauthorized tools; credentials and global Codex settings are unchanged.

To use the tools from an agent:

```bash
npm run windows:serve
# Or screenshot-only controls:
npm run windows:gui
```

For a stdio MCP registration, run `node` with the absolute path to
`native/cli.mjs` followed by `serve`; append `--interface gui` for GUI. A session
owns one game and one Xvfb display and stops them on disconnect. Only one owned
game can use this project's Wine prefix at a time. Explicit
`--attach --display :1958` observes an existing game without owning its lifetime.

| Interface      | Tools                                                                  |
| -------------- | ---------------------------------------------------------------------- |
| Native MCP     | `get_controls`, `get_screenshot`, `game_state`, `start_round`, `slice` |
| Screenshot GUI | `get_controls`, `get_screenshot`, `click`, `drag`                      |

`slice` plans one stroke, including target selection and bomb clearance, as in
the browser pilot. Both interfaces accept paths of at most 1 second and 5,000
screen pixels/s. GUI `drag` and `click` return a fresh screenshot with input
execution timing, without native object state or suggested targets.

The optimized planner compares the original greedy chain with horizontal,
vertical, diagonal and fruit-pair-aligned sweeps in both directions. It predicts
fruit intersections along each complete path, favors multi-fruit combos,
and checks the entire timed path against moving bombs. Brief mouse-down holds
at entry and exit let the 30fps game sample the stroke reliably. These holds
are explicit points and count toward the same one-second limit.
The planner also considers visible fruit edges near screen boundaries, and
offset cuts that can reach fruit outside a nearby bomb's smaller collision sphere.
It uses recovered fruit rewards and combo-group fields when ranking candidates,
and avoids the pause-button area. `FN_PLANNER=legacy` selects chain-only planning
with the current controller timings; it is not an exact reproduction of the
earlier 348-point implementation.

## Reproduce the REA analysis

```bash
npm run windows:rea
# Or inspect just one recovered function:
node native/investigate.mjs 0x4e0b00
```

This uses an existing REA checkout and Ghidra installation, defaulting to the
sibling `../rea` checkout and its local toolchains. Override `REA_CLI`,
`REA_NODE`, `GHIDRA_INSTALL_DIR` and `JAVA_HOME` when needed. It does not configure
an MCP client or install an analysis engine. Complete REA responses, a compact
ledger and exported Evidence bundles go under `.local/windows/evidence/repro-*`.

[RE-NOTES.md](RE-NOTES.md) distinguishes static findings from runtime checks and
links the original Evidence IDs. [re-layout.json](re-layout.json) pins the
executable hash and recovered layout. Runtime rejects other executable builds.

The native collision contract required one change to the reused strategy:
begin outside the first fruit's collision sphere, then enter it. A short stroke
entirely inside that sphere did not cut the menu fruit in live verification.
The planner also converts simulation motion to wall-time motion using the
observed simulation clock; freeze effects and camera shake remain prediction
limitations. It never pauses the game or changes its clock, score or rules.

## Verification and local artifacts

The best observed **scripted MCP** run is
`.local/windows/demos/accuracy-recording-threads/`: **411 points**, 132 gameplay
strokes, with native **NO FRUIT DROPPED** and **NO BOMBS HIT** bonuses visible in
`result.png`. The older scripted demo in `demos/native-verified/` scored 348.
The current version's verification repeat in `demos/final-validation-1/` scored 301. Native spawns and powerups are unseeded, so 411 is a best observed run, not a
stable score or evidence of a global optimum. Failed and weaker development
experiments remain locally rather than being treated as improvements.

The 411-point video is encoded at 30 fps. Arena-motion analysis measured about
**24.6 visible updates/s**, with a 95th-percentile update gap of 66.7 ms at the
0.1% changed-area threshold. It does not establish stable 30 or 60 fps on this
CPU-only renderer. The encoder/filter worker limits, persistent input worker
and batched native snapshots reduce avoidable work; host load still varies.
The 800 × 600 probe did not improve the recorded result, so 1024 × 768 remains
the default. `quality.json` and `frame-pacing.png` retain the measurements.

The current model comparison is saved in
`.local/windows/comparisons/terra-high-ready-game-only/` (see `summary.json` for
scores and interface audits): **MCP 300 / GUI 73**, with 228 / 11 completed
player tool calls and 90 / 10 gameplay strokes. Both interface audits passed.
The new pair measured approximately **19.5 visible updates/s on MCP** and
**25.1 on GUI**, at the same changed-area threshold. GUI includes idle frames
and MCP selects motion windows, so these are separate descriptive measurements,
not a controlled frame-rate comparison.
Both players use **gpt-6.1-terra / high**. Startup
is gated on the first player tool call for both interfaces. Previous comparisons
started the game before launching the model, losing 11–14 seconds before the
first MCP call; this is a protocol correction, not an isolated algorithm A/B.
The previous pure-game pair (`terra-high-game-only/`) scored 274 / 87, and the
older panel pair (`terra-high-optimized/`) scored 294 / 75. These model-controlled
runs must not be conflated with the scripted 348- or 411-point demonstrations.

`comparison.mp4` is the aligned viewing copy; each interface has its complete
`video.mp4`, settled `result.png`, prompt, tool trace, source snapshot and timing
metadata. The `strokes` count includes two common menu gestures. Interface audit
and infrastructure status must pass before treating a model run as valid. The
initial approval-configuration failure remains in
`terra-high-approval-failed/INVALID.json` and is excluded from player results.

```bash
npm run test:windows
npm run typecheck
```

The focused tests cover ballistic interception, moving-bomb clearance, visible
sphere edges, entry from outside a sphere, transformed coordinates, stale and
torn observations, input/result concurrency, first-tool initialization gating,
and the screenshot-only GUI contract. Actual Wine startup, native reads, MCP
calls, input, clock completion and score changes are verified by recordings.

The game came from a third-party historical archive; hashes identify the sample
but do not authenticate an unmodified official release. Game binaries, original
assets, decompiled output and recordings remain ignored local files. The DXVK
patch is an altered version of upstream code under [its license](DXVK-LICENSE.txt).
