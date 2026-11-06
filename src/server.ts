import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GameRuntime, viewport } from "./runtime.js";
import type { Interface } from "./types.js";

const point = z
  .object({
    x: z.number().finite().min(0),
    y: z.number().finite().min(0),
    t_ms: z.number().int().min(0).max(1000),
  })
  .strict();
export const rules = {
  clock: "realtime",
  timing:
    "After starting, the game runs continuously on monotonic wall time, including thinking, all observations, screenshots and input calls. Nothing pauses or advances it by request. Observations become stale while you reason. A path takes real time to execute.",
  physics:
    "Fixed 120 Hz, normal game gravity and launch speed. For a short time t, x≈x0+vx*t, y≈y0+vy*t+0.5*g*t². Both arms disable camera shake and visual slow motion; neither arm slows the game.",
  blade: {
    minimum_duration_ms: 16,
    maximum_duration_ms: 1000,
    maximum_points: 32,
    maximum_speed_px_s: 5000,
    semantics:
      "One continuous mouse-down path, then mouse-up. No targeting or path planning in the executor. Native browser mouse events and the game's collision detector are shared by MCP and GUI.",
  },
  scoring:
    "Fruit gives 1 point; 3+ fruit in one stroke can earn a bonus. Gaps over 340ms break combos. Arcade: bombs subtract 10 (floor 0); every 20 sliced fruit triggers 6s of double points and removes active bombs. Classic: a bomb or 3 escapes ends the game. Zen: no bombs or escape penalty.",
  session:
    "One prepared round. Start when ready; it never pauses, resets, or restarts. Finishing early does not stop the independent game clock.",
};

export function buildServer(
  runtime: GameRuntime,
  mode: Interface = "mcp",
): McpServer {
  const server = new McpServer(
    {
      name: mode === "mcp" ? "fruit-ninja-mcp" : "fruit-ninja-gui",
      version: "0.2.0",
    },
    {
      instructions:
        mode === "mcp"
          ? "Play a continuously running REALTIME game. Read controls and scene, then start_game once. Thinking, observations and input calls all consume real game time. Use visible-object state and your own timed canvas paths. No reset, pause, future spawns or autopilot. Act sequentially and reuse action results; state may be stale by the time an action executes."
          : "Operate the REALTIME Fruit Ninja browser using screenshots and native mouse coordinates only. Read get_controls and screenshot, find the start button in the image, click it, then drag through fruit and avoid bombs. The game never pauses during thinking, screenshots or input. No DOM, OCR, object state, app commands, resets or developer tools are available. Coordinates are full-image pixels.",
    },
  );
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
    readOnly = false,
  ): void {
    const schema = z.object(shape).strict();
    server.registerTool<z.ZodRawShape, typeof schema>(
      name,
      {
        description,
        inputSchema: schema,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: false,
          idempotentHint: readOnly,
          openWorldHint: false,
        },
      },
      async (args): Promise<CallToolResult> => {
        try {
          const value = await handler(schema.parse(args));
          if (value && typeof value === "object" && "content" in value)
            return value as CallToolResult;
          return {
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: value as Record<string, unknown>,
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      },
    );
  }
  const screenshot = async (): Promise<CallToolResult> => ({
    content: [
      {
        type: "image",
        mimeType: "image/png",
        data: (await runtime.screenshot()).toString("base64"),
      },
    ],
  });
  if (mode === "gui") {
    tool(
      "get_controls",
      "Read static game rules and generic mouse controls. No dynamic game state is provided.",
      {},
      async () => ({
        ...rules,
        viewport,
        coordinates:
          "Full screenshot pixels. Find the start button and arena visually. Drag points use t_ms starting at 0.",
      }),
      true,
    );
    tool(
      "get_screenshot",
      "Capture the real browser image. The game continues during capture and while you reason. No extracted text or state accompanies the image.",
      {},
      screenshot,
      true,
    );
    tool(
      "click",
      "Ordinary native left mouse click in full screenshot pixels; returns the next screenshot. Start by clicking the visible start button.",
      {
        x: z.number().finite().min(0).max(viewport.width),
        y: z.number().finite().min(0).max(viewport.height),
      },
      async ({ x, y }) => {
        await runtime.click(x, y);
        return screenshot();
      },
    );
    tool(
      "drag",
      "Native mouse-down path in full screenshot pixels, then release. 2..32 points; t_ms starts at 0 and strictly increases, total 16..1000ms, max 5000px/s. The path takes real wall time; returns only a screenshot.",
      { points: z.array(point).min(2).max(32) },
      async ({ points }) => {
        await runtime.guiDrag(points);
        return screenshot();
      },
    );
    tool(
      "wait",
      "Sleep 1..3000 real milliseconds with the mouse released, then capture a screenshot. The game keeps moving.",
      { duration_ms: z.number().int().min(1).max(3000) },
      async (input) => {
        await runtime.wait(input);
        return screenshot();
      },
    );
    return server;
  }
  tool(
    "get_game_rules",
    "Read realtime timing, shared physics/scoring and bounded input limits.",
    {},
    async () => ({
      ...rules,
      coordinates:
        "Canvas pixels, origin top-left, velocities px/s and gravity px/s². Scene includes only current visible objects, with no future spawn or RNG access.",
    }),
    true,
  );
  tool(
    "get_scene",
    "Read a timestamped CURRENT scene: visible fruit/bombs, velocities, hit radii, score, events and wall-clock audit. Time does not stop. Read rules and prepare before starting.",
    {},
    () => runtime.scene(),
    true,
  );
  tool(
    "start_game",
    "Start the one prepared round NOW. From this moment the world moves during inference, screenshots and every call. No reset or restart is permitted.",
    {},
    () => runtime.start(),
  );
  tool(
    "swipe",
    "Execute your timed canvas path using native browser mouse events. The world keeps moving in real time. Returns the current scene/events after execution. No automatic aiming. Optional observed_at_ms records observation age; expected_revision only protects against another action, not advancing time.",
    {
      points: z.array(point).min(2).max(32),
      expected_revision: z.number().int().min(0).optional(),
      observed_at_ms: z.number().finite().min(0).optional(),
    },
    (input) => runtime.swipe(input),
  );
  tool(
    "wait",
    "Sleep in real time for 1..3000ms with the blade lifted, then return the current scene. This does not control or pause the game clock.",
    { duration_ms: z.number().int().min(1).max(3000) },
    (input) => runtime.wait(input),
  );
  tool(
    "get_events",
    "Read actual slice, escape, bomb and round events since a sequence number. The game keeps running.",
    {
      after_seq: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(100),
    },
    ({ after_seq, limit }) => runtime.events(after_seq, limit),
    true,
  );
  tool(
    "get_screenshot",
    "Inspect the real rendered browser. Capture and inference time count toward the running game.",
    {},
    screenshot,
    true,
  );
  return server;
}

export async function serve(
  runtime: GameRuntime,
  mode: Interface = "mcp",
): Promise<void> {
  const server = buildServer(runtime, mode);
  const close = async () => {
    await server.close();
    await runtime.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  server.server.onclose = () => void runtime.close();
  await server.connect(new StdioServerTransport());
}
