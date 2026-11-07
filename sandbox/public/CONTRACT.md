# Builder contract

You receive an unfamiliar piece of software as a black box: a packaged single-page browser
game at `/opt/target/game/index.html`, described by `/opt/target/manifest.json`. Explore it
and build an **MCP server** that lets a later player agent play it well in real time. You
are not told how the player will be evaluated. No gameplay MCP, game API or solution is
provided.

## Your sandbox

- Offline: no network, no package installation. Unprivileged user, read-only system.
- Writable: `/work` (scratch) and `/output` (your deliverable). Both are discarded after the
  session except what `build` freezes.
- Available: Node.js 22, Chromium at `/usr/bin/chromium`, and the toolchain in
  `/opt/toolchain/node_modules` (`@modelcontextprotocol/sdk`, `zod`, `playwright-core`,
  `acorn`). Bare imports of these resolve from any directory.
- Public helpers: `node /opt/toolchain/fn/bin/fn-inspect.js` (static JS analysis),
  `node /opt/toolchain/fn/bin/fn-port.js` (runs the game behind the same game port your MCP
  gets at play time), `node /opt/toolchain/fn/bin/fn-mcp.js` (talk to your own stdio MCP), and
  `/opt/toolchain/fn/port-client.js` (optional port client).
- You may inspect everything shipped to a user, including the browser-delivered JavaScript,
  and you may run the game in your own Chromium with Playwright for exploration.

## Controller tools

`exec(argv, timeout_ms, cwd, stdin)`, `read_file(path, max_bytes)`,
`write_file(path, content, encoding, executable)` (only under `/output/`),
`inspect_js(op, args, file)`, `build()`, `smoke(sha256)` and `handoff(sha256, notes)`.
Every call and its full input and output are recorded.

## Deliverable

```
/output/
  mcp/launch.sh      executable; starts your MCP server on stdio
  mcp/...            server code and an optional in-page adapter
  mcp/deps/          any extra dependencies (a README if there are none)
  manifest.json      {"tools": [{"name", "mechanism"}], "adapter": "mcp/adapter.js" | null}
  intermediate/      your exploration evidence (scripts, notes, outputs)
  docs/README.md     notes for humans
```

Only `mcp/` is deployed, read-only, at `/opt/mcp` in a fresh offline sandbox that has Node.js
and the same toolchain but **no browser, no display and no game files**. `launch.sh` must not
assume `/output`; use paths relative to its own directory. stdout must carry only MCP
JSON-RPC; write diagnostics to stderr. There is no setup step and no network.

At play time your server reaches the live game only through the **game port** described in
`PORT.md` (environment variable `FN_GAME_PORT`). The port runs your declared adapter inside the
game page and executes native mouse input with the same limits as a human-like GUI player.

## Rules

- Tools take data arguments only, never code, scripts or expressions.
- Do not build a generic screen, mouse or keyboard driver: that is the GUI condition, not an
  application MCP. MCP tools must not return images; pixels are withheld from the port.
- Input reaches the game only as native mouse input through the port: at most one input (one
  path or one click) per player tool call. Dispatched DOM events are ignored by the game.
- Your adapter may observe the page, including by wrapping Canvas 2D rendering calls. It must
  not alter game rules, geometry, timing or input; the host freezes JavaScript built-ins before
  loading it, and integrity violations invalidate a session.
- Handle situations you did not see while building; the round, timing and spawns vary.
- Declare each tool and the mechanism it uses in `manifest.json`. Mark tools needing human
  review with `"free_form": true`.

## Build, smoke, handoff

`build` validates `/output` (required files, regular files only, modes 0644/0755, safe paths,
manifest) and freezes it by SHA-256. `smoke` deploys a frozen artifact into a fresh play
sandbox with a fresh game and checks initialize, `tools/list`, strict stdout and the
interface rules above; it returns full logs. Passing smoke does not show that your tools
work; test them yourself with `fn-port`. `handoff` hands off one artifact that passed smoke
and ends the session. Frozen artifacts are never repaired.
