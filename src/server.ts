import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GameRuntime } from "./runtime.js";

const point = z
  .object({
    x: z
      .number()
      .finite()
      .min(0)
      .describe("Canvas x in pixels, origin at upper left"),
    y: z
      .number()
      .finite()
      .min(0)
      .describe("Canvas y in pixels, positive downward"),
    t_ms: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .describe(
        "Milliseconds since blade-down; first point is 0, later points strictly increase",
      ),
  })
  .strict();

export const rules = {
  clock: "decision",
  timing:
    "The world is frozen while you think or inspect. Only wait and swipe advance simulation; both return the next scene. Real inference time is logged separately. A swipe advances moving fruit along its path, so account for velocity.",
  coordinates:
    "Canvas pixels, origin top-left, x rightward, y downward. Arena bounds are in every scene. vx/vy are px/s; gravity is px/s². Only objects intersecting the viewport are returned; no future spawns or RNG state are exposed.",
  physics:
    "Fixed 120 Hz. For a short future interval t seconds, x≈x0+vx*t and y≈y0+vy*t+0.5*gravity*t². Walls can reflect horizontal velocity. No cinematic slow motion or camera shake in decision mode.",
  blade: {
    minimum_duration_ms: 16,
    maximum_duration_ms: 1000,
    maximum_speed_px_s: 5000,
    maximum_points: 32,
    semantics:
      "One continuous blade-down trajectory; the blade lifts at the end. All segments go through the game's normal collision detector. You choose all coordinates and times; tools do not target IDs or plan paths.",
  },
  modes: {
    classic: "3 escaped fruit or any bomb ends the round; no time limit.",
    arcade:
      "60 seconds by default; bombs subtract 10 (floor 0). Every 20 sliced fruit triggers 6 seconds of double points and removes active bombs.",
    zen: "90 seconds by default; no bombs or escape penalty.",
  },
  scoring:
    "Fruit gives 1 point (2 during arcade frenzy). Three or more fruit in a continuous stroke can earn a bonus equal to their fruit points when the stroke finishes; gaps over 340 ms break the combo.",
  workflow:
    "Read rules and scene. If ready, new_game. When no suitable fruit is visible, wait with until_objects=true, or wait a chosen duration to let fruit rise. Use the latest scene revision for each action. After an action, plan from its returned scene instead of spending an extra get_scene call. Never run multiple actions concurrently.",
};

export function buildServer(runtime: GameRuntime, locked = false): McpServer {
  const server = new McpServer(
    { name: "fruit-ninja-mcp", version: "0.1.0" },
    {
      instructions:
        "Play the real Fruit Ninja game using structured visible-object observations and timed blade paths. Start with get_game_rules and get_scene. The decision clock freezes during thinking; only wait/swipe advance game time. Use the latest revision, act sequentially, and reuse each action's returned scene. Positions are canvas pixels, velocities px/s. Paths collide with fruit AND bombs through the game's own detector. There is no autopilot or future-spawn access.",
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
          destructiveHint: name === "new_game",
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
  tool(
    "get_game_rules",
    "Read units, time semantics, physics, scoring, trajectory limits and the recommended tool workflow.",
    {},
    async () => ({ ...rules, new_game_available: !locked }),
    true,
  );
  if (!locked)
    tool(
      "new_game",
      "Start/reset your owned game. Choose a reproducible seed. Resets score and events. Trial sessions start automatically and omit this tool.",
      {
        mode: z.enum(["classic", "arcade", "zen"]).default("arcade"),
        seed: z.number().int().min(0).max(4294967295).default(42),
        duration_seconds: z
          .number()
          .int()
          .min(5)
          .max(90)
          .optional()
          .describe(
            "Optional shortened/extended arcade or zen round; omitted uses the game's original duration. Not supported in classic.",
          ),
      },
      (args) => runtime.newGame(args),
    );
  tool(
    "get_scene",
    "Read the current scene without advancing time. Includes visible fruit/bombs, stable IDs, positions, velocities, hit radii, score and action revision. No future state.",
    {},
    () => runtime.scene(),
    true,
  );
  tool(
    "swipe",
    "Execute ONE timed blade-down polyline and lift the blade. Fruit keep moving throughout the stroke. Points are canvas pixels with increasing t_ms starting at 0; total 16..1000 ms, max 5000 px/s. Returns next scene and hit/escape events. Stale revisions or invalid paths are rejected before anything changes.",
    {
      expected_revision: z.number().int().min(0),
      points: z.array(point).min(2).max(32),
    },
    (args) => runtime.swipe(args),
  );
  tool(
    "wait",
    "Advance 1..3000 ms with the blade lifted. Set until_objects=true to stop at the first visible object (returns immediately if one is already visible); false waits the entire duration. Returns next scene and events.",
    {
      expected_revision: z.number().int().min(0),
      duration_ms: z.number().int().min(1).max(3000),
      until_objects: z.boolean().default(false),
    },
    (args) => runtime.wait(args),
  );
  tool(
    "get_events",
    "Read sliced fruit, bomb hits, escaped fruit and round-end events after a sequence number; does not advance time.",
    {
      after_seq: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(100),
    },
    (args) => runtime.events(args.after_seq, args.limit),
    true,
  );
  tool(
    "get_screenshot",
    "View the real rendered game. Does not advance the decision clock. Prefer get_scene for compact observations; screenshots are useful to inspect the visual result.",
    {},
    async () => ({
      content: [
        {
          type: "image",
          mimeType: "image/png",
          data: (await runtime.screenshot()).toString("base64"),
        },
      ],
    }),
    true,
  );
  return server;
}

export async function serve(
  runtime: GameRuntime,
  locked = false,
): Promise<void> {
  const server = buildServer(runtime, locked);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close();
    await runtime.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  const transport = new StdioServerTransport();
  server.server.onclose = () => void runtime.close();
  await server.connect(transport);
}
