# Architecture and trust boundaries (Phase 0)

The reference design (`mcps-reef-rea`) targets native desktop software: a protected controller,
an offline builder sandbox, freeze by hash, smoke in a fresh sandbox, GUI input withheld from MCP
solves, and hidden probes. This repository keeps those ideas and replaces the native mechanisms.
Instead of ELF hashes, Frida and XTEST withholding, it uses a packaged browser build, an in-page
adapter loaded into a hardened realm, and a narrow game port.

## Roles and what each can reach

| Role            | Runs in                                                      | Can reach                                                     | Cannot reach                                                  |
| --------------- | ------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------- |
| Builder agent   | host process (LLM loop)                                      | controller tools only                                         | shell, network, repository, referee                           |
| Builder sandbox | `builder` image, `--network none`, uid 10001, read-only root | packaged game, Chromium, public toolchain, `/work`, `/output` | repository, referee, fixtures, credentials, other projects    |
| Generated MCP   | `play` image, `--network none`, uid 10001, read-only root    | its frozen `mcp/` (read-only), the game-port socket           | browser, game page, referee, artifacts, credentials           |
| Adapter         | page main world, after hardening                             | DOM, Canvas 2D rendering calls                                | referee handle, host hooks, page source, built-in replacement |
| Evaluator       | `evaluator` image with docker socket                         | everything; owns the browser and the referee                  | —                                                             |

Credentials live only in the evaluator's LLM loop: they are read from a named environment
variable, sent as an Authorization header, and never logged. Sandboxes receive no host
environment. Tests check this with a canary key.

## Game builds

- **Packaged** (`npm run package` → `.local/package/`): pinned upstream HTML plus the public
  rules patch and a manifest. This is the builder's only target. The rules are:
  - a wall-clock 120 Hz pump;
  - a seeded spawn RNG, set once through the one-shot `__fnPrepare`;
  - pause, home and restart disabled;
  - gameplay and start accept trusted (native) events only;
  - mode, motion effects and arena geometry locked after prepare;
  - a CSP with no network and no string compilation in page contexts.
- **Refereed** (per session): the same rules plus a referee hook block inside the closure. It
  handles events, stats, visible-object state, stroke attribution and integrity checks. It
  registers under a random one-time key; the evaluator captures it into a CDP handle and
  deletes the key. Referee errors reach interfaces as one-line codes only.

## Controls and how they are tested

| Shortcut or risk                  | Control                                                                                                  | Test                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Builder sees internals            | Image contexts assembled from public files only and scanned for private markers; images scanned again    | `package` scan, `sandbox.test`      |
| Supplied gameplay MCP             | None exists in images; the legacy reference MCP is evaluator-only                                        | image scan                          |
| Reading referee state             | Referee only behind a host-held handle; key deleted; scripts removed; no extra port routes               | `boundary.test`, privileged fixture |
| Seeds or future spawns            | Seed passed once through a one-shot hook that self-deletes; not in page source                           | `boundary.test`                     |
| Synthetic DOM input               | Gameplay and start ignore `isTrusted !== true`                                                           | `boundary.test`, privileged fixture |
| Hooking input, geometry or timing | Lockdown freezes built-in constructors, prototypes and global bindings                                   | `boundary.test`, privileged fixture |
| CSS geometry tampering            | Referee compares canvas rect, arena, mode and motion to a baseline; any violation invalidates            | `boundary.test`, privileged fixture |
| Unattributed slices               | Every slice must occur during a host-executed stroke                                                     | all play tests                      |
| GUI wrapper                       | Static policy rejects screen/mouse/keyboard primitives; port withholds pixels; image results are blocked | GUI-wrapper fixture                 |
| Generic code executor             | Static policy rejects code tools, arguments and descriptions; adapter frozen by hash                     | `unit-policy.test`                  |
| Autopilot                         | One native input per player tool call, none outside a call; one path at a time, never queued             | privileged fixture, `port.test`     |
| No-op MCP                         | Success requires a started, completed round, legal paths and slices                                      | no-op fixture                       |
| Clock manipulation                | External telemetry drift and finish-time audit                                                           | all play tests                      |
| Tampered artifact                 | Inventory re-hashed before smoke and play; links and extra files rejected                                | `unit-policy.test`                  |

A play result is `valid_gameplay` only when `failure_reasons` is empty. Scores are always
reported raw, whatever the validity.

## Parity between play modes

Both modes use the same refereed build, prepare call, hardening, wall clock, start mechanism (a
native click on the start button), `validatePath`/`executeTimedPath` executor, limits (2–32
points, 16–1000 ms, 5000 px/s), single-path rule, and run directory layout. They differ only in
observation (pixels versus the agent's adapter) and in the one-line interface description.

## Known gaps (accepted for Phase 0)

- Code generation inside host-initiated adapter calls (DevTools-protocol evaluation) is not
  blocked: Playwright's own main-world evaluation needs `eval`. CSP blocks deferred string
  compilation (timers, handlers), adapters are frozen by hash, and tool arguments cannot carry
  code. Raw-CDP adapter calls could close this later.
- The adapter shares the page realm. Built-ins are frozen and geometry is audited, but a
  sufficiently clever adapter might find an untested way to influence the page. Game objects
  are unreachable through built-ins, and the integrity checks invalidate detected tampering.
- The 32-bit spawn LCG could in principle be inferred from observed spawns.
- Hidden functional acceptance probes run by a model are Phase 1; smoke checks the protocol and
  interface only.
- Debian's Chromium is pinned by image digest and recorded version, not by package version.
- Docker access is required. The evaluator container can control the host Docker daemon; it
  labels and cleans only its own containers.
