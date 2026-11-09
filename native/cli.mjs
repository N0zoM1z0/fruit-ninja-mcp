#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { launchGame } from "./transport.mjs";
import { NativeState } from "./state.mjs";
import { planStroke } from "./planner.mjs";
import { planComboStroke } from "./combo-planner.mjs";

const run = promisify(execFile);
const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const root = fileURLToPath(new URL("..", import.meta.url));

export class GameController {
  constructor(runtime, { onEvent } = {}) {
    this.runtime = runtime;
    this.reader = new NativeState(runtime.helper);
    this.buttonDown = false;
    this.onEvent = onEvent ?? (() => {});
  }
  async observe() {
    const state = await this.reader.observe();
    this.onEvent({ type: "state", state });
    return state;
  }

  async ready() {
    if (this.readyDone) return this.observe();
    const deadline = performance.now() + 60000;
    let state;
    do {
      try {
        state = await this.observe();
      } catch (error) {
        if (!error.message.includes("entity manager is not ready")) throw error;
        await sleep(250);
        continue;
      }
      if (state.fruits.length >= 2) {
        // Entities are allocated before the opening camera/menu animation is
        // finished. Let the visible controls settle before accepting input.
        await sleep(4500);
        const focused = await this.runtime.helper.request("focus");
        if (!focused.ok)
          throw new Error(`Unable to focus native game: ${focused.error}`);
        await run(
          "xdotool",
          [
            "search",
            "--onlyvisible",
            "--name",
            "^Fruit Ninja$",
            "windowfocus",
            "--sync",
          ],
          { env: { ...process.env, DISPLAY: this.runtime.display } },
        );
        this.reader.clockHistory = [];
        this.readyDone = true;
        return this.observe();
      }
      await sleep(250);
    } while (performance.now() < deadline);
    throw new Error("Game menu did not become ready within 60 seconds");
  }

  async mouse(x, y, down) {
    const info = await this.runtime.helper.request("info");
    const b = info.window;
    if (
      !info.alive ||
      !b ||
      ![x, y].every(Number.isFinite) ||
      x < b.left ||
      x >= b.left + b.width ||
      y < b.top ||
      y >= b.top + b.height
    )
      throw new Error("Native input outside the live game window");
    await this.runtime.desktop.request({ op: "mouse", x, y, down });
    this.buttonDown = down;
    this.lastMouse = { x, y };
  }

  async execute(points, startAt = performance.now()) {
    if (this.inputClosed)
      throw new Error("The evaluated round has ended; native input is closed");
    if (this.executing)
      throw new Error("Native input is busy; wait for the current stroke");
    this.executing = true;
    try {
      return await this.performPath(points, startAt);
    } finally {
      this.executing = false;
    }
  }

  async performPath(points, startAt) {
    const info = await this.runtime.helper.request("info");
    const bounds = info.window;
    if (!bounds || points.length < 2 || points.length > 256)
      throw new Error("Invalid native path");
    if (points[0].t_ms !== 0)
      throw new Error("The first path timestamp must be zero");
    let previous = -1;
    for (const p of points) {
      if (
        ![p.x, p.y, p.t_ms].every(Number.isFinite) ||
        p.t_ms <= previous ||
        p.t_ms > 1000 ||
        p.x < bounds.left ||
        p.x >= bounds.left + bounds.width ||
        p.y < bounds.top ||
        p.y >= bounds.top + bounds.height
      )
        throw new Error("Path outside client bounds or timing limit");
      previous = p.t_ms;
    }
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      if ((Math.hypot(b.x - a.x, b.y - a.y) / (b.t_ms - a.t_ms)) * 1000 > 5000)
        throw new Error("Native input exceeds the common 5000 px/s speed cap");
    }
    if (performance.now() - startAt > 100)
      throw new Error(
        "Stroke plan expired before execution; observe and plan again",
      );
    this.onEvent({
      type: "path",
      points,
      start_epoch_ms: performance.timeOrigin + startAt,
    });
    const execution = await this.runtime.desktop.request({
      op: "path",
      points,
      start_epoch_ms: performance.timeOrigin + startAt,
    });
    this.onEvent({ type: "execution", execution });
    return execution;
  }

  async menuStroke(worldX, worldY, canvas, radius = 50) {
    const x = canvas.left + ((worldX + canvas.W / 2) * canvas.width) / canvas.W;
    const y = canvas.top + ((canvas.H / 2 - worldY) * canvas.height) / canvas.H;
    const reach = Math.max(160, (radius * canvas.height) / canvas.H + 30);
    await this.execute([
      { x, y: Math.max(canvas.top + 1, y - reach), t_ms: 0 },
      { x, y: Math.min(canvas.top + canvas.height - 1, y + reach), t_ms: 350 },
    ]);
    await sleep(1000);
  }

  async startRound() {
    if (this.reader.started)
      throw new Error(
        "One round per session; launch a new session for another round",
      );
    const state = await this.ready();
    if (state.phase === "result")
      throw new Error(
        "Attach selected an already finished round; launch a fresh session",
      );
    // Two visible menu gestures, independently observed on this pinned build.
    await this.menuStroke(16, -66, state.canvas);
    // Startup animations can still intercept the first gesture on a busy
    // software renderer. Retry only while the same main-menu fruit remains;
    // never issue a second gesture after the mode menu or round has opened.
    let modeMenu,
      lastGesture = performance.now(),
      gestures = 1;
    const menuDeadline = performance.now() + 10000;
    do {
      await sleep(150);
      modeMenu = await this.observe();
      if (modeMenu.fruits.filter((f) => !f.moving).length >= 3) break;
      if (this.reader.started)
        throw new Error("Unexpected round during main-menu navigation");
      const main = modeMenu.fruits.some(
        (f) => !f.moving && Math.abs(f.x - 256) < 5 && Math.abs(f.y - 246) < 5,
      );
      if (main && gestures < 3 && performance.now() - lastGesture > 2000) {
        await this.menuStroke(16, -66, modeMenu.canvas);
        lastGesture = performance.now();
        gestures++;
      }
    } while (performance.now() < menuDeadline);
    // Mode fruit are allocated before the visible slide-in unlocks them.
    await sleep(1500);
    modeMenu = await this.observe();
    await writeFile(
      path.join(root, ".local/windows/evidence/start-states.json"),
      JSON.stringify({ main: state, modes: modeMenu }, null, 2),
    );
    const arcade = modeMenu.fruits
      .filter((fruit) => !fruit.moving)
      .sort((a, b) => b.y - a.y)[0];
    if (!arcade || modeMenu.fruits.length < 3)
      throw new Error("Mode menu did not open after the New Game stroke");
    await this.menuStroke(
      arcade.x - modeMenu.canvas.W / 2,
      modeMenu.canvas.H / 2 - arcade.y,
      modeMenu.canvas,
      arcade.r,
    );
    let lastArcadeGesture = performance.now(),
      arcadeGestures = 1;
    const deadline = performance.now() + 25000;
    let scene;
    do {
      await sleep(100);
      scene = await this.observe();
      if (
        scene.remaining > 1 &&
        scene.remaining <= 60 &&
        scene.phase !== "result"
      ) {
        this.reader.started = true;
        return this.observe();
      }
      if (
        !(scene.remaining > 0 && scene.remaining <= 65) &&
        scene.fruits.filter((f) => !f.moving).length >= 3 &&
        arcadeGestures < 3 &&
        performance.now() - lastArcadeGesture > 2000
      ) {
        const next = scene.fruits
          .filter((f) => !f.moving)
          .sort((a, b) => b.y - a.y)[0];
        await this.menuStroke(
          next.x - scene.canvas.W / 2,
          scene.canvas.H / 2 - next.y,
          scene.canvas,
          next.r,
        );
        lastArcadeGesture = performance.now();
        arcadeGestures++;
      }
    } while (performance.now() < deadline);
    await writeFile(
      path.join(root, ".local/windows/evidence/start-failure.png"),
      await this.screenshot(),
    );
    throw new Error(
      "Arcade round did not start; inspect .local/windows/evidence/start-failure.png",
    );
  }

  async slice(options = {}) {
    try {
      return await this.sliceOnce(options);
    } catch (error) {
      if (/snapshot changed|plan expired|read-failed/.test(error.message))
        return { ok: false, reason: "state-changing", detail: error.message };
      throw error;
    }
  }

  async sliceOnce(options = {}) {
    const wait = Math.max(
      0,
      40 - (performance.now() - (this.lastSliceAt ?? 0)),
    );
    if (wait) await sleep(wait);
    this.lastSliceAt = performance.now();
    let state = await this.observe();
    if (!this.reader.started || state.phase !== "playing")
      return { ok: false, reason: "not-playing", state };
    const deadline = performance.now() + Math.min(options.wait_ms ?? 150, 500);
    while (!state.fruits.length && performance.now() < deadline) {
      await sleep(25);
      state = await this.observe();
    }
    const planner =
      process.env.FN_PLANNER === "legacy" ? planStroke : planComboStroke;
    const plan = planner(state, {
      lead_ms: 35,
      step_ms: 35,
      speed: 4200,
      max_duration_ms: 450,
      bomb_margin: 10,
      ...options,
      now_ms: performance.now(),
    });
    if (!plan.ok) return { ...plan, state };
    this.onEvent({ type: "plan", plan, state });
    let execution;
    try {
      execution = await this.execute(plan.points, plan.start_at_ms);
    } catch (error) {
      if (/plan expired|snapshot changed/.test(error.message))
        return { ok: false, reason: "retry-state", detail: error.message };
      throw error;
    }
    const after = await this.observe();
    const active = new Set(after.fruits.map((f) => f.id));
    return {
      ...plan,
      execution,
      state: after,
      outcome: {
        score_delta: after.score - state.score,
        targets_planned: plan.targets.length,
        still_active: plan.targets.filter((id) => active.has(id)),
      },
    };
  }

  async screenshot({ emit = true } = {}) {
    const result = await this.runtime.desktop.request({ op: "screenshot" });
    const png = Buffer.from(result.data, "base64");
    if (emit) this.onEvent({ type: "screenshot", png });
    return png;
  }
}

export async function createServer(
  runtime,
  mode = "mcp",
  { onEvent, preparedRound = false, beforeAction } = {},
) {
  if (!["mcp", "gui"].includes(mode))
    throw new Error("Interface must be mcp or gui");
  const game = new GameController(runtime, { onEvent });
  await game.ready();
  const server = new McpServer(
    { name: `fruit-ninja-windows-${mode}`, version: "0.1.0" },
    {
      instructions: preparedRound
        ? beforeAction
          ? "The evaluator enters Arcade on your first tool call after model readiness. Then play immediately; never navigate menus, pause, restart or replay."
          : "The evaluator has already started one Arcade round. Play immediately; never navigate menus, restart or replay. All thinking and calls consume real game time."
        : mode === "mcp"
          ? "Play the original Windows game in real time. game_state reads REA-recovered native object lists. start_round enters Arcade once; slice uses the previously explored ballistic/interception strategy and executes one mouse stroke. All thinking and calls consume real game time."
          : "Play the original Windows game using screenshots and native mouse input. Slice New Game, then Arcade Mode. Avoid bombs and make combos. Thinking, screenshots and strokes consume real time.",
    },
  );
  function tool(name, description, shape, handler) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: shape,
        annotations: {
          readOnlyHint:
            !beforeAction && ["get_controls", "game_state"].includes(name),
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        const began = performance.now();
        game.onEvent({ type: "tool:start", name, args });
        try {
          await beforeAction?.();
          const result = await handler(args);
          game.onEvent({
            type: "tool:end",
            name,
            duration_ms: performance.now() - began,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
          };
        } catch (error) {
          game.onEvent({
            type: "tool:end",
            name,
            duration_ms: performance.now() - began,
            error: error.message,
          });
          return {
            isError: true,
            content: [{ type: "text", text: error.message }],
          };
        }
      },
    );
  }
  tool(
    "get_controls",
    "Read the common game rules and native input limits.",
    {},
    async () => {
      const info = await runtime.helper.request("info");
      return {
        title: "Fruit Ninja HD (Windows)",
        interface: mode,
        viewport: info.window,
        rules:
          "Slice fruit; avoid bombs. Arcade lasts 60 game seconds. " +
          (preparedRound
            ? "The evaluator has already started Arcade; play immediately."
            : "Slice the visible menu fruit to navigate."),
        path: {
          units: "screen pixels",
          max_duration_ms: 1000,
          max_points: 256,
        },
      };
    },
  );
  server.registerTool(
    "get_screenshot",
    {
      description:
        "Capture the live game screen. Time continues while observing.",
      inputSchema: {},
      annotations: {
        readOnlyHint: !beforeAction,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const began = performance.now();
      game.onEvent({ type: "tool:start", name: "get_screenshot" });
      try {
        await beforeAction?.();
        const png = await game.screenshot();
        game.onEvent({
          type: "tool:end",
          name: "get_screenshot",
          duration_ms: performance.now() - began,
        });
        return {
          content: [
            {
              type: "image",
              mimeType: "image/png",
              data: png.toString("base64"),
            },
          ],
        };
      } catch (error) {
        game.onEvent({
          type: "tool:end",
          name: "get_screenshot",
          duration_ms: performance.now() - began,
          error: error.message,
        });
        return {
          isError: true,
          content: [{ type: "text", text: error.message }],
        };
      }
    },
  );
  if (mode === "mcp") {
    tool(
      "game_state",
      "Read score, clock and active fruit/bomb state from the native Windows process.",
      {},
      () => game.observe(),
    );
    if (!preparedRound)
      tool(
        "start_round",
        "Enter one Arcade round through the visible menu using native input.",
        {},
        () => game.startRound(),
      );
    tool(
      "slice",
      "Plan and execute one ballistic interception stroke, then return the new native state.",
      {
        speed: z.number().min(600).max(4800).optional(),
        max_duration_ms: z.number().min(20).max(1000).optional(),
        bomb_margin: z.number().min(0).max(100).optional(),
        wait_ms: z.number().min(0).max(500).optional(),
      },
      (options) => game.slice(options),
    );
  } else {
    const guiTool = (name, description, shape, handler) =>
      server.registerTool(
        name,
        {
          description,
          inputSchema: shape,
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false,
          },
        },
        async (args) => {
          const began = performance.now();
          game.onEvent({ type: "tool:start", name, args });
          try {
            await beforeAction?.();
            const execution = await handler(args);
            const png = await game.screenshot();
            game.onEvent({
              type: "tool:end",
              name,
              duration_ms: performance.now() - began,
            });
            return {
              content: [
                { type: "text", text: JSON.stringify(execution) },
                {
                  type: "image",
                  mimeType: "image/png",
                  data: png.toString("base64"),
                },
              ],
            };
          } catch (error) {
            game.onEvent({
              type: "tool:end",
              name,
              duration_ms: performance.now() - began,
              error: error.message,
            });
            return {
              isError: true,
              content: [{ type: "text", text: error.message }],
            };
          }
        },
      );
    guiTool(
      "drag",
      "Execute one timed mouse-down path using screenshot coordinates and return a fresh game screenshot.",
      {
        points: z
          .array(
            z.object({
              x: z.number(),
              y: z.number(),
              t_ms: z.number().min(0).max(1000),
            }),
          )
          .min(2)
          .max(256),
      },
      async ({ points }) => game.execute(points),
    );
    guiTool(
      "click",
      "Perform one native left click at a screenshot position.",
      { x: z.number(), y: z.number() },
      async ({ x, y }) => {
        return game.execute([
          { x, y, t_ms: 0 },
          { x, y, t_ms: 100 },
        ]);
      },
    );
  }
  return { server, game };
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      interface: { type: "string", default: "mcp" },
      display: { type: "string" },
      attach: { type: "boolean", default: false },
    },
  });
  const runtime = await launchGame({
    root,
    display: values.display,
    attach: values.attach,
  });
  await writeFile(
    path.join(root, ".local/windows/session.json"),
    JSON.stringify({
      display: runtime.display,
      pid: process.pid,
      game_pid: runtime.gamePid,
      interface: values.interface,
    }),
  );
  let server, game, closing;
  const close = () =>
    (closing ??= (async () => {
      try {
        if (game?.buttonDown && game.lastMouse)
          await game.mouse(game.lastMouse.x, game.lastMouse.y, false);
      } finally {
        await server?.close();
        await runtime.close();
      }
    })());
  process.on("SIGINT", () => close().finally(() => process.exit()));
  process.on("SIGTERM", () => close().finally(() => process.exit()));
  process.stdin.on("end", () => close().finally(() => process.exit()));
  try {
    ({ server, game } = await createServer(runtime, values.interface));
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await close();
    throw error;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
